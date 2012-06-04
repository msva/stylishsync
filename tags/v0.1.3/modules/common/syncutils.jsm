// $Id$

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://services-sync/record.js");
Components.utils.import("resource://services-sync/main.js");
try         { Components.utils.import("resource://services-common/async.js"); }
catch (exc) { Components.utils.import("resource://services-sync/async.js"); } // Compatibility with Gecko < 14

var EXPORTED_SYMBOLS = [ "SyncUtil", "SyncUIAdder", "SyncError", "SyncStringBundle" ];

var Logging = null;

function SyncError(txt, level) {
  if (level === undefined) level = 0
  this.message = txt;
  this.name    = "SyncError";
  let info = Logging.callerInfo(level+1);
  for (let p in info)
    this[p] = info[p];
}
SyncError.prototype = new Error();
SyncError.prototype.constructor = SyncError;

function SyncStringBundle(engname, rscname) {
  this.load(engname, rscname);
}

SyncStringBundle.prototype = {
  _bundle: null,
  load: function SSB_load(engname, rscname) {
    rscname = rscname || engname;
    this._bundle = Services.strings.createBundle("chrome://"+rscname+"/locale/"+engname+".properties");
  },
  
  get: function SSB_get(key) {
    return this._bundle.GetStringFromName(key);
  }
};

var SyncUtil = {
  Async: Async,

  setLogging: function SU_setLogging(obj) {
    Logging = obj;
  },
  
  sleep: function SU_sleep(time) {
    let cb = Async.makeSyncCallback();
    let timer = Components.classes["@mozilla.org/timer;1"]
                          .createInstance(Components.interfaces.nsITimer)
    timer.initWithCallback(cb, time, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
    Async.waitForSyncCallback(cb);
  },

  yield: function SU_yield(storeObj) {
    this.sleep(0);
  },
  
  lockWeave: function SU_lockWeave(timeout) {
    timeout = timeout || 0;
    let start  = Date.now();
    do {
      let locked = Weave.Service.lock();
      if (locked) return true;
      this.yield();
    } while (Date.now()-start < timeout);
    return false;
  },
  
  assert: function SU_assert(cond, txt)
  {
    if (!cond)
      throw new SyncError(txt||"Assertion Error", 1);
  },

  unique: function SU_unique(arr) {
   let seen = {};
   return arr.filter(function(elt) {
     let ok = !seen[elt]; if (ok) seen[elt] = true;
     return ok;
   });
  },
  
  reEscape: function SU_reEscape(str) {
    return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  },
  
  arrayEqual: function SU_arrayEqual(l,r) {
    return (l==r) || !(l<r || l>r);
  },

  makeBackupFile: function(bakdir, basename, ext, age) {
    let now = new Date();
    if (bakdir.exists()) { // otherwise, must be created by caller...
      // Clean up old backups
      let dir = bakdir.directoryEntries;
      let bnpatt = this.reEscape(basename||"backup");
      let expatt = this.reEscape(ext||".bak");
      let patt   = new RegExp("^"+bnpatt+"-\\d{4}-\\d\\d-\\d\\d"+expatt);
      
      while (dir.hasMoreElements()) { // clean up old backups
        let f = dir.getNext().QueryInterface(Components.interfaces.nsIFile);
        if (patt.test(f.leafName)) {
          if (now.getTime()-f.lastModifiedTime > age) {
            f.remove(false); Logging.debug("removed backup: "+f.leafName);
          }
        }
      }
    }
    let file = bakdir.clone();
    file.append(now.toLocaleFormat(basename+"-%Y-%m-%d"+ext));
    return file;        
  },
  
  loggedCatch: function SU_loggedCatch(proto) {
    return function SU_loggedWrapper() {
      try { return proto.apply(this, arguments); }
      catch (exc) { Logging.logException(exc); throw exc; }
    }
  },
  
  errorLoggedClass: function SU_errorLoggedClass(clazz) {
    for (let func in clazz.prototype) {
      if (typeof clazz.prototype[func] == "function") {
        let get = clazz.prototype.__lookupGetter__(func);
        let set = clazz.prototype.__lookupSetter__(func);
        if (get)
          clazz.prototype__defineGetter__(func, this.loggedCatch(get));
        else if (set)
          clazz.prototype__defineSetter__(func, this.loggedCatch(set));
        else
          clazz.prototype[func] = this.loggedCatch(clazz.prototype[func]);
      }
    }
    return clazz;
  },
  
  // Maybe we can re-use this if we write another sync engine :)
  promptAndSync: function SU_promptAndSync(parent, engine, startPrompt, mergePrompt) {
    if (Weave.Status.service != Weave.STATUS_OK) {
      Logging.debug("Sync is not active");
      return false;
    }

    let eng = Weave.Engines.get(engine);
    SyncUtil.assert(!!eng, "Engine '"+engine+"' not registered");
    
    let wasLocked = Weave.Service.locked;
    if (!wasLocked) Weave.Service.lock();
    
    let strings          = new SyncStringBundle(engine);
    let deferredSyncCall = null;

    try {
      startPrompt      = startPrompt || "firstStartPrompt";
      mergePrompt      = mergePrompt || "mergePrompt";
      let cancelPrompt = " ("+strings.get("sameAsCancel")+")";
      let cancelChoice = -1;
      
      let choices = [ strings.get(mergePrompt),
                      strings.get("wipeClientPrompt"),
                      strings.get("wipeServerPrompt"),
                      strings.get("disablePrompt")
                    ];
      let disableChoice = choices.length-1;

      if      (startPrompt == "firstStartPrompt") cancelChoice = disableChoice;
      else if (startPrompt == "restoredPrompt")   cancelChoice = 0;
      
      if (cancelChoice >= 0) choices[cancelChoice] += cancelPrompt;

      let selected = {value: 0};
      let ok = Services.prompt.select(parent, // may be null on first start
                                      strings.get(engine),
                                      strings.get(startPrompt),
                                      choices.length, choices, selected);

      if      (!ok && cancelChoice >= 0) selected.value = cancelChoice;
      else if (!ok) return true;

      eng.enabled = (selected.value != disableChoice);

      if (!eng.enabled) { Logging.debug("Disabling sync"); return true; }

      switch (selected.value) {
        case 0: deferredSyncCall = function _resetClient() {
            Logging.debug("Merging data (waiting for sync)");
            Weave.Service.resetClient([eng.name]);
          }; break;
        case 1: deferredSyncCall = function _wipeClient() {
            Logging.debug("Wiping client");
            Weave.Service.wipeClient([eng.name]);
          }; break;
        case 2: deferredSyncCall = function _wipeServer() {
            Logging.debug("Wiping server");
            Weave.Service.resetClient([eng.name]);
            Weave.Service.wipeServer([eng.name]);
            Weave.Clients.sendCommand("wipeEngine", [eng.name]);
          }; break;
      }
    } finally {
      if (!wasLocked) Weave.Service.unlock();
    }
    // Call sync service after unlocking it
    if (deferredSyncCall) {
      try {
        SyncUtil.yield();

        if (eng.trackerInstance) // try to sync as soon as possible
          eng.trackerInstance.score += Weave.SCORE_INCREMENT_XLARGE;

        deferredSyncCall();

      } catch (exc) {
        Logging.logException(exc);
        Services.prompt.alert(parent, strings.get(engine), strings.get("syncError"));
        return false;
      }
    }
    return true;
  },

  // Bind this to a Record object!
  fixDecryptBug: function ___FIXME___(keyBundle) { 
    // FIXME: seems to be a bug in sync. On startup we get called from
    // canDecrypt() without collection or keyBundle)
    if (!this.collection && !keyBundle) {
      try { throw new SyncError("Trace!"); }
      catch (exc) { Logging.debug("FIXME: No collection or keyBundle: "+exc.stack); }
      return;
    }
    CryptoWrapper.prototype.decrypt.call(this, keyBundle);
  }

};

// Manually add preferences to sync UI
// borrowed from https://addons.mozilla.org/en-US/seamonkey/addon/add-ons-sync-prefs/

function SyncUIAdder(engID, engName) {
  this.engID   = engID;
  this.engName = engName;
  this.init();
}

SyncUIAdder.prototype = {
  PREF_WINDOW_TYPES:  { "mozilla:preferences": "SeaMonkey",
                        "Browser:Preferences": "Firefox" },
  SETUP_WINDOW_TYPES: { "Weave:AccountSetup":  "all" },
  
  paneload: null,
  
  // Implement window listener
  onOpenWindow: function SUI_onOpenWindow(win) {
    let self = this;
    // Wait for the window to finish loading
    let domWin = win.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                    .getInterface(Components.interfaces.nsIDOMWindow);

    domWin.addEventListener("load", function SUI_domWindowLoad() {
      domWin.removeEventListener("load", SUI_domWindowLoad, false);
      let wintype = domWin.document.documentElement.getAttribute("windowtype");

      if (self.PREF_WINDOW_TYPES[wintype])
        self.addPrefs(domWin);
      else if (self.SETUP_WINDOW_TYPES[wintype])
        self.addToWizard(domWin);

    }, false);
  },
  onCloseWindow: function SUI_onCloseWindow(win) { },
  onWindowTitleChange: function SUI_onWindowTitleChange(win, title) { },
  
  addPrefs: function SUI_addPrefs(win) {
    let self = this;
    if (!win) return;
    
    let wintype  = win.document.documentElement.getAttribute("windowtype");
    let syncpane = win.document.getElementById(this.PREF_WINDOW_TYPES[wintype] == "SeaMonkey" ?
                                               "sync_pane" : "paneSync");
    if (!syncpane) return;

    if (syncpane.firstChild) { // pane is set up
      self.addToSyncPane(win, syncpane);
    } else {
      this.paneload = function SUI_paneload() {
        syncpane.removeEventListener("paneload", SUI_paneload, false);
        self.addToSyncPane(win, syncpane);
      }
      syncpane.addEventListener("paneload", this.paneload, false);
    }
  },
  
  removePrefs: function SUI_removePrefs(win) {
    if (!win) return;
    let doc = win.document;
    let wintype  = doc.documentElement.getAttribute("windowtype");
    let syncpane = doc.getElementById(this.PREF_WINDOW_TYPES[wintype] == "SeaMonkey" ?
                                      "sync_pane" : "paneSync");
    if (!syncpane) return;
    
    if (this.paneload) syncpane.removeEventListener("paneload", this.paneload, false);
    if (syncpane.firstChild) { // pane is set up
      let engList = doc.getElementById("syncEnginesList");
      let item    = doc.getElementById("SUI_"+this.engID);
      engList.removeChild(item);
      let pref = doc.getElementById("engine."+this.engID);
      if (pref)  pref.setAttribute("readonly", true);
    }
  },
  
  addToSyncPane: function SUI_addToSyncPane(win, syncpane) {
    Logging.debug("Adding preferences to option dialog");
    let doc      = win.document;
    let prefs    = syncpane.getElementsByTagName("preferences")[0];
    let pref     = doc.getElementById("engine."+this.engID);
    if (pref) {
      pref.removeAttribute("readonly");
    } else {
      pref = doc.createElement("preference");
      pref.setAttribute("id",   "engine."+this.engID);
      pref.setAttribute("name", "services.sync.engine."+this.engID);
      pref.setAttribute("type", "bool");
      prefs.appendChild(pref);
    }
    let engList = doc.getElementById("syncEnginesList");
    let wintype = doc.documentElement.getAttribute("windowtype");
    let item    = null;
    let parent  = null;

    if (this.PREF_WINDOW_TYPES[wintype] == "SeaMonkey") {
      item = doc.createElement("listitem");
      item.setAttribute("id",    "SUI_"+this.engID);
      item.setAttribute("type",  "checkbox");
    } else {
      parent = doc.createElement("richlistitem");
      parent.setAttribute("id",    "SUI_"+this.engID);
      item = doc.createElement("checkbox");
      parent.appendChild(item);
    }
    item.setAttribute("label", this.engName);
    item.setAttribute("preference", "engine."+this.engID);
    item.setAttribute("checked",    Services.prefs.getBoolPref("services.sync.engine."+this.engID));
    engList.appendChild(parent ? parent : item);
  },
  
  addToWizard: function SUI_addToWizard(win) {
    let self = this;
    Logging.debug("Adding preferences to setup dialog");
    let doc      = win.document;
    // enabled preference
    let item     = doc.createElement("checkbox");
    item.setAttribute("id",    "engine."+this.engID);
    item.setAttribute("label", this.engName);
    item.setAttribute("checked",    Services.prefs.getBoolPref("services.sync.engine."+this.engID));
    let after    = doc.getElementById("engine.tabs");
    after.parentNode.appendChild(item);
    item.addEventListener("command", function SUI_wizardPref() {
      Weave.Svc.Prefs.set("engine."+self.engID, item.getAttribute("checked") == "true");
    }, false);
    // wipe list
    let dlist = doc.getElementById("dataList");
    let label = doc.createElement("label");
    label.setAttribute("id",    this.engID+"Wipe");
    label.setAttribute("value", this.engName);
    label.setAttribute("class", dlist.firstChild.getAttribute("class"));
    dlist.appendChild(label);
  },
  
  removeFromWizard: function SUI_removeFromWizard(win) {
    let elt = win.document.getElementById("engine."+this.engID);
    elt.parentNode.removeChild(elt);
    elt = win.document.getElementById(this.engID+"Wipe");
    elt.parentNode.removeChild(elt);
  },
  
  init: function SUI_startupUI() {
    try {
      for (let type in this.PREF_WINDOW_TYPES) {
        let enm = Services.wm.getEnumerator(type);
        while (enm.hasMoreElements()) this.addPrefs(enm.getNext());
      }
      for (let type in this.SETUP_WINDOW_TYPES) {
        let enm = Services.wm.getEnumerator(type);
        while (enm.hasMoreElements()) this.addToWizard(enm.getNext());
      }
      Services.wm.addListener(this);
    } catch (exc) {
      Logging.logException(exc);
    }
  },
  
  close: function SUI_shutdownUI() {
    try {
      Services.wm.removeListener(this);
      for (let type in this.PREF_WINDOW_TYPES) {
        let enm = Services.wm.getEnumerator(type);
        while (enm.hasMoreElements()) this.removePrefs(enm.getNext());
      }
      for (let type in this.SETUP_WINDOW_TYPES) {
        let enm = Services.wm.getEnumerator(type);
        while (enm.hasMoreElements()) this.removeFromWizard(enm.getNext());
      }
    } catch (exc) {
      Logging.logException(exc);
    }
  },
}


var SimpleLogging = {
  PFX:   "synclog: ",
  DEBUG: false,
  
  log:   function SL_log(  txt) { Services.console.logStringMessage(this.PFX + txt); },
  info:  function SL_info( txt) { this.log(txt); },
  debug: function SL_debug(txt) { if (this.DEBUG) this.log("DEBUG: "+txt); },
  warn:  function SL_warn( txt) { this.log("WARNING: "+txt); },
  error: function SL_eror( txt) { this.log("ERROR: "  +txt); },
  
  logException: function SL_logException(exc) { Components.utils.reportError(exc); },
  callerInfo:   function SL_callerInfo() {
    try { this.undef() } catch (exc) { return { stack: exc.stack }; }
    return {}; // shouldn't happen
  }
};

Logging = SimpleLogging;
