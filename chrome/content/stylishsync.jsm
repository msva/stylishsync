// $Id$

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("chrome://stylishsync/content/stsutils.jsm");
Components.utils.import("resource://services-sync/engines.js");
Components.utils.import("resource://services-sync/record.js");
Components.utils.import("resource://services-sync/util.js");
Components.utils.import("resource://services-sync/main.js");
Components.utils.import("resource://services-sync/constants.js");

var EXPORTED_SYMBOLS = [ "StylishSync", "StylishSyncEngine", "StylishSyncRecord" ];

var trackerInstance = null;

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


function assert(cond, txt)
{
  if (!cond)
    throw new SyncError(txt||"Assertion Error", 1);
}

function SyncStringBundle() {
  this.load();
}

SyncStringBundle.prototype = {
  _bundle: null,
  load: function SSB_load() {
    this._bundle = Services.strings.createBundle("chrome://stylishsync/locale/stylishsync.properties");
  },
  
  get: function SSB_get(key) {
    return this._bundle.GetStringFromName(key);
  }
};

var StylishSync = {
  appStart: true,
  stylish:  null,
  strings:  null,
  
  startup: function STS_startup(data, reason) {
    Services.strings.flushBundles();
    this.strings = new SyncStringBundle();
    if (reason == 1) // app start
      Services.obs.addObserver(this, "weave:service:ready",  false);
    else {
      this.appStart = false;
      this.observe(null, "weave:service:ready", null);
    }
    Services.obs.addObserver(this, "addon-options-displayed", false);
    Logging.debug("startup: " + reason);
  },
  
  shutdown: function STS_shutdown(data, reason) {
    let engine = Weave.Engines.get("stylishsync");
    Logging.debug("unregistering '"+(engine?engine.Name:"<not found>")+"'");
    if (trackerInstance)
      trackerInstance.observe(null, "weave:engine:stop-tracking", null);
    if (engine)
      Weave.Engines.unregister(engine);
    try { Services.obs.removeObserver(this, "addon-options-displayed"); }
    catch (exc) {}
    Logging.debug("shutdown: " + reason);
  },
  
  observe: function STS_observe(subject, topic, data) {
    Logging.debug("STS_observe: " + subject + ", " + topic);
    switch (topic) {
      case "weave:service:ready":
        if (this.appStart)
          Services.obs.removeObserver(this, "weave:service:ready");

        try { this.stylish = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle); }
        catch (exc) {}

        if (this.stylish === null) {
          Logging.warn("Stylish doesn't seem to be installed. Exiting.");
          return;
        }

        if (!Weave.Service.lock()) {
          Logging.error("Cannot lock sync service. Engine not registered.");
          return;
        }

        try {

          Weave.Engines.register(StylishSyncEngine);
          Logging.debug("Engine registered.");
        
          if (this.isFirstStart()) {
            Logging.debug("First start");
            this.promptAndSync();
          }

        } finally {
          Weave.Service.unlock();
        }
        break;

      case "addon-options-displayed":
        if (data == "{0e3fc079-afbb-4a00-87e5-9486062d0f9c}") {
          let self = this;
          subject.getElementById("stsreset-button")
                 .addEventListener("command", function STS_onResetButton() {
                    self.promptAndSync("resetPrompt", "keepPrompt");
                 }, false);
        }
        break;
    }
  },
  
  promptAndSync: function STS_promptAndSync(startPrompt, mergePrompt) {
    let eng = Weave.Engines.get("stylishsync");
    assert(!!eng, "Engine not registered");
    
    startPrompt = startPrompt || "firstStartPrompt";
    mergePrompt = mergePrompt || "mergePrompt";
    
    let choices = [ this.strings.get(mergePrompt),
                    this.strings.get("wipeClientPrompt"),
                    this.strings.get("wipeServerPrompt"),
                    this.strings.get("disablePrompt")
                  ];
    if (startPrompt != "firstStartPrompt")
      choices[0] += " ("+this.strings.get("sameAsCancel")+")";
    else
      choices[choices.length-1] += " ("+this.strings.get("sameAsCancel")+")";
      
    let selected = {value: 0};
    let ok = Services.prompt.select(null,
                                    this.strings.get("stylishsync"),
                                    this.strings.get(startPrompt),
                                    choices.length, choices, selected);

    if (!ok && startPrompt == "firstStartPrompt")
      selected.value = choices.length-1; // disable engine
    
    eng.enabled = (selected.value != choices.length-1);

    if (!eng.enabled) { Logging.debug("Disabling sync"); return; }

    switch (selected.value) {
      case 0: Logging.debug("Merging data (waiting for sync)"); break;
      case 1: Logging.debug("Wiping client"); eng.wipeClient(); break;
      case 2: Logging.debug("Wiping server"); eng.wipeServer(); break;
    }
    if (trackerInstance)
      trackerInstance.score += SCORE_INCREMENT_XLARGE;
  },
  
  isFirstStart: function STS_isFirstStart() {
    let data = null, conn = null, stmt = null;
    try {
      data = Components.classes["@userstyles.org/stylish-data-source;1"].createInstance(Components.interfaces.stylishDataSource);
      conn = data.getConnection();
      stmt = conn.createStatement("select count(*) as count from style_meta where name = 'syncguid'");
      stmt.executeStep();
      return stmt.row.count == 0;
    } catch (exc) {
      Logging.logException(exc);
      return false;
    } finally {
      if (stmt) { stmt.reset(); stmt.finalize(); }
      if (conn) { conn.close(); }
    }
    
  }
  
};

const STYLE_PROPS = [
  "url",  "idUrl",   "updateUrl", "md5Url", "name",
  "code", "enabled", "originalCode"
];

const STYLE_META = [ "url", "url-prefix", "domain", "regexp", "type", "tag" ];
const STYLISH_MODE_SYNCING = 1024;

function StyleWrapper(guid, styleobj) {
  this.svc   = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle);
  this.guid  = guid;
  this.style = null;
  if (guid) {
    let styles = this.svc.findByMeta("syncguid", guid, this.svc.CALCULATE_META | this.svc.REGISTER_STYLE_ON_CHANGE, {});
    if (styles.length != 0) assert(styles.length == 1);
    this.style = styles[0];
  } else if (styleobj) {
    this.guid  = Utils.makeGUID();
    this.style = styleobj;
    if (this.style) {
      let m = this.style.getMeta("syncguid", {});
      assert( m.length == 0 || m.length == 1);
      if (m.length == 0) {
        this.style.addMeta("syncguid", this.guid);
        this.save();
      }
      else
        this.guid = m[0];
    }
  }
  if (!this.style) {
    this.style = Components.classes["@userstyles.org/style;1"].createInstance(Components.interfaces.stylishStyle);
    this.style.mode = this.svc.CALCULATE_META | this.svc.REGISTER_STYLE_ON_CHANGE;
    this.style.init(null, null, null, null, null, "", false, null);
    this.style.addMeta("syncguid", this.guid);
  }
  this.id   = this.style.id;
  for (let p in STYLE_PROPS)
    this[STYLE_PROPS[p]] = this.style[STYLE_PROPS[p]];
}

StyleWrapper.prototype = {
  save: function STW_save() {
    this.style.mode |= STYLISH_MODE_SYNCING;
    this.style.save();
  },
  
  delete: function STW_delete() {
    this.style.mode |= STYLISH_MODE_SYNCING;
    this.style.delete();
  },
  
  fromRecord: function STW_fromRecord(rec) {
    for (let p in STYLE_PROPS)
      this.style[STYLE_PROPS[p]] = rec[STYLE_PROPS[p]];
    if (rec.meta) {
      let self = this;
      for (let name in rec.meta) {
        self.style.removeAllMeta(name);
        rec.meta[name].forEach(function (val) {
          self.style.addMeta(name, val);
        });
      }
    }
  },
  
  toRecord: function STW_toRecord(rec) {
    for (let p in STYLE_PROPS)
      rec[STYLE_PROPS[p]] = this.style[STYLE_PROPS[p]];
    rec.meta = {};
    let self = this;
    STYLE_META.forEach(function (name) {
      let m = self.style.getMeta(name, {});
      if (m && m.length > 0) rec.meta[name] = m;
    });
  }
  
};

function StylishSyncRecord(collection, id) {
  CryptoWrapper.call(this, collection, id);
}

StylishSyncRecord.prototype = {
  __proto__: CryptoWrapper.prototype,
  _logName: "Record.StylishSync",
  
};

Utils.deferGetSet(StylishSyncRecord, "cleartext", STYLE_PROPS.concat(["meta"]));

function StylishSyncStore(name) {
  this.svc = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle);
  Store.call(this, name);
}

StylishSyncStore.prototype = {
  __proto__: Store.prototype,
  
  itemExists: function STS_itemExists(id) {
    return new StyleWrapper(id).id != 0;
  },
  
  createRecord: function STS_createRecord(id, coll) {
    let rec  = new StylishSyncRecord(coll, id);
    let wrap = new StyleWrapper(id);
    Logging.debug("createRecord: "+id+", "+coll+", "+JSON.stringify(wrap));
    // I've got this from engines/passwords.js:
    if (wrap.id == 0) {
      rec.deleted = true;
    }
    else
      wrap.toRecord(rec);
    return rec;
  },
  
  changeItemID: function STS_changeItemID(old, neew) {
    Logging.debug("changeItemID: "+old+" -> "+neew);
    let wrap = new StyleWrapper(old);
    assert (wrap.style != null);
    wrap.style.removeAllMeta("syncguid");
    wrap.style.addMeta("syncguid", neew);
    wrap.save();
  },
  
  getAllIDs: function STS_getAllIDs() {
    Logging.debug("getAllIDs");
    let styles = this.svc.list(this.svc.CALCULATE_META | this.svc.REGISTER_STYLE_ON_CHANGE, {});
    let guids  = {};
    for (let s in styles) {
      let wrap = new StyleWrapper(null, styles[s]);
      guids[wrap.guid] = true;
    }
    return guids;
  },
  
  wipe: function STS_wipe() {
    let styles = this.svc.list(this.svc.CALCULATE_META | this.svc.REGISTER_STYLE_ON_CHANGE, {});
    for (let s in styles)
      new StyleWrapper(null, styles[s]).delete();
  },
  
  create: function STS_create(rec) {
    return this.update(rec);
  },
  
  update: function STS_update(rec) {
    Logging.debug("update: "+JSON.stringify(rec.cleartext));
    let wrap = new StyleWrapper(rec.id);
    wrap.fromRecord(rec);
    if (wrap.style.name != null)
      wrap.save();
    else
      Logging.debug("update tried to save null name...");
  },
  
  remove: function STS_remove(rec) {
    Logging.debug("remove: "+JSON.stringify(rec));
    let wrap = new StyleWrapper(rec.id);
    if (wrap.style.id != 0)
      wrap.delete();
  }
};

function StylishSyncTracker(name) {
  Tracker.call(this, name);
  if (!trackerInstance) {
    Services.obs.addObserver(this, "stylish-style-add",    false);
    Services.obs.addObserver(this, "stylish-style-change", false);
    Services.obs.addObserver(this, "stylish-style-delete", false);
    Services.obs.addObserver(this, "weave:engine:stop-tracking", false);
    Logging.debug("StylishSyncTracker singleton created");
    trackerInstance = this;
  } else {
    Logging.debug("StylishSyncTracker already present!");
  }
}

StylishSyncTracker.prototype = {
  __proto__: Tracker.prototype,
  _enabled:  true,
  
  observe: function STT_observe(subject, topic, data) {
    Logging.debug("STT_observe: " + subject + ", " + topic);
    switch (topic) {
      case "stylish-style-add":
      case "stylish-style-change":
      case "stylish-style-delete":
        let style = subject;
        if ((style.mode & STYLISH_MODE_SYNCING) == 0) {
          let wrap = new StyleWrapper(null, style);
          this.addChangedID(wrap.guid);
          let now = Services.prefs.getBoolPref("extensions.stylishsync.immediate");
          this.score += now ? SCORE_INCREMENT_XLARGE : SCORE_INCREMENT_MEDIUM;
        } else {
          Logging.debug("already syncing: "+style.id+", "+style.name);
          style.mode &= ~STYLISH_MODE_SYNCING;
        }
        break;
        
      case "weave:engine:stop-tracking":
        Services.obs.removeObserver(this, "stylish-style-add");
        Services.obs.removeObserver(this, "stylish-style-change");
        Services.obs.removeObserver(this, "stylish-style-delete");
        Services.obs.removeObserver(this, "weave:engine:stop-tracking");
        break;
    }
  }
};

function StylishSyncEngine() {
  Weave.SyncEngine.call(this, "StylishSync");
  this.svc = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle);
}

StylishSyncEngine.prototype = {
  __proto__:   Weave.SyncEngine.prototype,
  _recordObj:  StylishSyncRecord,
  _storeObj:   StylishSyncStore,
  _trackerObj: StylishSyncTracker,

  _findDupe: function STS_findDupe(rec) {
    Logging.debug("_findDupe: "+JSON.stringify(rec.cleartext));
    let styles = this.svc.list(this.svc.CALCULATE_META | this.svc.REGISTER_STYLE_ON_CHANGE, {});
    for (let s in styles) {
      let wrap = new StyleWrapper(null, styles[s]);
      if (wrap.guid && wrap.name == rec.name && wrap.code.trim() == rec.code.trim())
        return wrap.guid;
    }
    return null;
  }
  
};

