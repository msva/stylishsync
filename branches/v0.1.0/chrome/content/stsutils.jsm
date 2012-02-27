// $Id$

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/FileUtils.jsm");
Components.utils.import("resource://gre/modules/DownloadLastDir.jsm");  
Components.utils.import("resource://gre/modules/PopupNotifications.jsm");
Components.utils.import("resource://services-sync/main.js");

var EXPORTED_SYMBOLS = [ "SyncError", "StylishBackup", "SyncStringBundle",
                         "StsUtil",  "Logging" ];

//*****************************************************************************
//* Helpers
//*****************************************************************************
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

var StsUtil = {
  assert: function STU_assert(cond, txt)
  {
    if (!cond)
      throw new SyncError(txt||"Assertion Error", 1);
  },

  unique: function STU_unique(arr) {
   let seen = {};
   return arr.filter(function(elt) {
     let ok = !seen[elt]; if (ok) seen[elt] = true;
     return ok;
   });
  },
  
  arrayEqual: function STU_arrayEqual(l,r) {
    return (l==r) || !(l<r || l>r);
  },

  loggedCatch: function STU_loggedCatch(proto) {
    return function STU_loggedWrapper() {
      try { return proto.apply(this, arguments); }
      catch (exc) { Logging.logException(exc); throw exc; }
    }
  },
  
  errorLoggedClass: function STU_errorLoggedClass(clazz) {
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
  promptAndSync: function STS_promptAndSync(parent, engine, startPrompt, mergePrompt) {
    let eng = Weave.Engines.get(engine);
    StsUtil.assert(!!eng, "Engine '"+engine+"' not registered");
    
    let wasLocked = Weave.Service.locked;
    if (!wasLocked) Weave.Service.lock();
    
    try {
      startPrompt      = startPrompt || "firstStartPrompt";
      mergePrompt      = mergePrompt || "mergePrompt";
      let strings      = new SyncStringBundle();
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
      else if (!ok) return;

      eng.enabled = (selected.value != disableChoice);

      if (!eng.enabled) { Logging.debug("Disabling sync"); return; }

      switch (selected.value) {
        case 0:
          Logging.debug("Merging data (waiting for sync)");
          Weave.Service.resetClient([eng.name]);
          break;
        case 1:
          Logging.debug("Wiping client");
          Weave.Service.wipeClient([eng.name]);
          break;
        case 2:
          Logging.debug("Wiping server");
          Weave.Service.resetClient([eng.name]);
          Weave.Service.wipeServer([eng.name]);
          Weave.Clients.sendCommand("wipeEngine", [eng.name]);
          break;
      }
      if (eng.trackerInstance) // try to sync as soon as possible
        eng.trackerInstance.score += Weave.SCORE_INCREMENT_XLARGE;
    } finally {
      if (!wasLocked) Weave.Service.unlock();
    }
  },
  
  fixDuplicateMetas: function STU_fixDuplicateMetas(stylish) {
    Components.utils.import("chrome://stylishsync/content/stsengine.jsm");

    Logging.debug("Fixing duplicate metas");

    let styles = stylish.list(StylishConst.STYLISH_MODE_FOR_SYNC ,{});
      
    styles.forEach(function(style) {
      let fixed = false;
      StylishConst.STYLE_META.forEach(function(meta) {
        let m = style.getMeta(meta, {});
        let u = StsUtil.unique(m);
        if (!StsUtil.arrayEqual(m, u)) {
          Logging.debug("Fixing duplicates for "+style.name+", "+meta);
          style.removeAllMeta(meta);
          u.forEach(function(val) { style.addMeta(meta, val); });
          fixed = true;
        }
      });
      if (fixed)
        style.save();
    });
  },
};

//*****************************************************************************
//* Backup / Restore
//*****************************************************************************

const assert = StsUtil.assert;

var StylishBackup = {
  OK:        0,
  CANCELLED: 1,
  FAILED:    2,
  
  bakdir: FileUtils.getDir("ProfD", ["stylishsync"]),
  
  backup: function STB_backup(sts, prompt, file) {
    let conn = null;
    
    try {
      if (prompt) {
        file = this.pickFile(sts, false);
        if (!file) return this.CANCELLED;
      } else if (!file) {
        let now = new Date();
        if (this.bakdir.exists()) { // otherwise, will be created later...
          // Do automatic backups like places: once a day
          let dir = this.bakdir.directoryEntries;
          let age = Services.prefs.getIntPref("extensions.stylishsync.bakage") * 24 * 3600 * 1000;
        
          while (dir.hasMoreElements()) { // clean up old backups
            let f = dir.getNext().QueryInterface(Components.interfaces.nsIFile);
            if (/^stylishsync-\d{4}-\d\d-\d\d\.sqlite/.test(f.leafName)) {
              if (now.getTime()-f.lastModifiedTime > age) {
                f.remove(false); Logging.debug("removed backup: "+f.leafName);
              }
            }
          }
        }
        file = this.bakdir.clone();
        file.append(now.toLocaleFormat("stylishsync-%Y-%m-%d.sqlite"));
        
        if (file.exists()) return this.CANCELLED;
      }
      if (file) {
        let data = Components.classes["@userstyles.org/stylish-data-source;1"].createInstance(Components.interfaces.stylishDataSource);
        if (!file.parent.exists())  file.parent.create(1, 0x700);
        if (file.exists())          file.remove(false);

        Services.storage.backupDatabaseFile(data.getFile(), file.leafName, file.parent);
        
        // remove GUIDs from backup
        conn = Services.storage.openDatabase(file);
        conn.schemaVersion = this.stylishSchema();
        conn.executeSimpleSQL("delete from style_meta where name = 'syncguid'");
        conn.executeSimpleSQL("vacuum");

        Logging.debug("created backup: "+file.path);
        return this.OK;
      }
    } catch (exc) {
      Logging.logException(exc);
    } finally {
      if (conn) conn.close();
    }
    return this.FAILED;
  },
  
  restore: function STB_restore(sts, file) {
    Components.utils.import("chrome://stylishsync/content/stsengine.jsm");

    let conn = null , stmt = null;
    try {
      if (!file) {
        file = this.pickFile(sts, true);
        if (!file || !Services.prompt.confirm(sts.window, sts.strings.get("stylishsync"),
                                                          sts.strings.get("confirmRestore")))
          return this.CANCELLED;
      }
      if (!file) return this.CANCELLED;
      
      let stylish = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle);
      
      conn        = Services.storage.openDatabase(file);
      assert(conn.schemaVersion == this.stylishSchema(), "Stylish database format changed. Cannot restore!");

      assert(Weave.Service.lock(), "Cannot lock sync service");
      
      let eng = Weave.Engines.get("stylishsync");
      assert(!!eng, "Engine not registered");
      
      eng.wipeClient();

      conn = Services.storage.openDatabase(file);
      
      stmt = conn.createStatement("select distinct s.*, m.name as meta, m.value as mval "+
                                   "from styles as s left outer join "+
                                        "style_meta as m on s.id = style_id "+
                                   "order by s.id");
      let style  = null;
      let lastId = -1;
      while (stmt.executeStep()) {
        let row = stmt.row;
        if (!style || row.id != lastId) {
          if (style)
            style.save();
          lastId = row.id;
          style = Components.classes["@userstyles.org/style;1"].createInstance(Components.interfaces.stylishStyle);
          style.mode = StylishConst.STYLISH_MODE_SYNCING | StylishConst.STYLISH_MODE_FOR_SYNC;
          style.init(row.url,  row.idUrl, row.updateUrl, row.md5Url,
                     row.name, row.code,  row.enabled,   row.originalCode); 
        }
        if (row.meta && row.meta != "syncguid")
          style.addMeta(row.meta, row.mval)
      }
      if (style)
        style.save();
        
      return this.OK;
    } catch (exc) {
      Logging.logException(exc);

    } finally {
      Weave.Service.unlock();
      if (stmt) { stmt.reset(); stmt.finalize(); }
      if (conn) { conn.close() };
    }
    return this.FAILED;
  },
  
  firstStart: function STB_firstStart(sts, doBackup) {
    gDownloadLastDir.setFile("chrome://stylishsync", this.bakdir);
    if (!this.bakdir.exists())
      this.bakdir.create(1, 0x700);
    if (doBackup) {
      let f = this.bakdir.clone();
      f.append("stylishsync-firstrun.sqlite");
      this.backup(sts, null, f);
    }
  },
  
  stylishSchema: function STB_stylishSchema() {
    let conn = null;
    try {
      let data = Components.classes["@userstyles.org/stylish-data-source;1"].createInstance(Components.interfaces.stylishDataSource);
      conn = data.getConnection();
      return conn.schemaVersion;
    } finally {
      if (conn) conn.close();
    }
  },
  
  pickFile: function STB_pickFile(sts, restore) {
    
    assert(!!sts.window, "No parent window for file picker");
    let name   = sts.strings.get("stylishsync");
    let title  = restore ? sts.strings.get("restorePrompt") : sts.strings.get("backupPrompt");
    let patt   = "stylish" + (restore ? "": "sync") + "*.sqlite";
    let FP     = Components.interfaces.nsIFilePicker;
    let picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(FP);

    picker.init(sts.window, name+" - "+title, restore ? FP.modeOpen : FP.modeSave);
    picker.appendFilter(name+" ("+patt+")", patt);
    picker.appendFilters(FP.filterAll);

    picker.displayDirectory = gDownloadLastDir.getFile("chrome://stylishsync");
    picker.defaultString    = restore ? "" : "stylishsync.sqlite";
    
    let ok = picker.show();
    
    if (ok == FP.returnCancel) return null;
    
    gDownloadLastDir.setFile("chrome://stylishsync", picker.displayDirectory);
    
    return picker.file;
  }
};

//*****************************************************************************
//* Logging
//*****************************************************************************
function CallerInfo() {
}

CallerInfo.prototype = {
  filename: null, fileName: null, sourceLine: null, lineNumber: null, columnNumber: null
}

var Logging = {
  PFX:        "stylishsync: ",
  logfile:    null,
  DEBUG:      Services.prefs.getBoolPref("extensions.stylishsync.debug"), // will be reloaded by main module
  
  callerInfo: function(level) { // should
    if (!level) level = 0;
    // see https://github.com/eriwen/javascript-stacktrace/blob/master/stacktrace.js
    var info = new CallerInfo();
    try { this.undef() /* throw exc with info */ }
    catch (exc) {
      info.stack = exc.stack;
      var stack = exc.stack.replace(/(?:\n@:0)?\s+$/m, '').replace(/^\(/gm, '{anonymous}(').split('\n');
      // "{anonymous}([object Object],\"refreshEngine\",[object Proxy])@chrome://gprivacy/content/gprivacy.js:134"
      if (stack.length > level+1) {
        var sinfo = stack[level+1].split('@');
        if (sinfo.length == 2) {
          info.sourceLine = sinfo[0];
          var c = sinfo[1].lastIndexOf(":");
          if (c != -1) { 
            info.filename   = info.fileName = sinfo[1].slice(0, c);
            info.lineNumber = parseInt(sinfo[1].slice(c+1));
          } else {
            info.filename   = info.fileName = sinfo[1]
            info.lineNumber = 1;
          }
        }
        else
          info.sourcLine = stack[level+1];
      }
    }
    return info;
  },
    
  _writeFile: function(msg) {
    if (this.logname !== undefined && this.logfile == null) return; // failed before
    if (this.logfile == null) {
      try         { this.logname = Services.prefs.getCharPref("extensions.stylishsync.logfile"); }
      catch (exc) { this.logname = null; }
      if (!this.logname) return;
      this.logfile = new FileUtils.File(this.logname);
      if (!this.logfile) return;
    }
    try {
      let ostream = FileUtils.openFileOutputStream(this.logfile, 0x1A)
      let sstream = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
                               .createInstance(Components.interfaces.nsIConverterOutputStream);
      sstream.init(ostream, "UTF-8", 0, 0);
      let logmsg = "["+new Date().toISOString()+"] "+
                   msg.toString().replace(/^stylishsync:\s*/,"");
      sstream.writeString(logmsg+"\n"); ostream.flush();
      sstream.close();
    } catch (exc) { this.logname = null; this._logException(exc, null, false); }
  },
  
  log: function(txt) {
    Services.console.logStringMessage(this.PFX + txt);
    this._writeFile(txt);
  },
  
  _logException: function(exc, txt, toFileIfOpen) {
    txt = txt ? txt + ": " : ""
    var excLog = Components.classes["@mozilla.org/scripterror;1"]
                           .createInstance(Components.interfaces.nsIScriptError);
    excLog.init(this.PFX + txt + (exc.message || exc.toString()),
                exc.filename || exc.fileName, exc.location ? exc.location.sourceLine : null,
                exc.lineNumber || 0, exc.columnNumber || 0,
                excLog.errorFlag || 0, "stylishsync");
    Services.console.logMessage(excLog);
    if (toFileIfOpen) this._writeFile(excLog);
  },
  
  logException: function(exc, txt) {
    this._logException(exc, txt, true);
  },
  
  info: function(txt) { this.log(txt); },

  debug: function(txt) { if (this.DEBUG) this.log("DEBUG: "+txt); },

  warn: function(txt, showSrcInfo, stackLevel) {
    var warn = Components.classes["@mozilla.org/scripterror;1"]
                         .createInstance(Components.interfaces.nsIScriptError);
    if (stackLevel  === undefined) stackLevel  = 0;
    var info = showSrcInfo ? this.callerInfo(stackLevel+1) : new CallerInfo();
    warn.init(this.PFX + txt, info.filename, info.sourceLine, info.lineNumber, info.columnNumber,
              warn.warningFlag, "stylishsync");
    Services.console.logMessage(warn);
    this._writeFile(warn);
  },
  
  error: function(txt, showSrcInfo, stackLevel) {
    var err = Components.classes["@mozilla.org/scripterror;1"]
                        .createInstance(Components.interfaces.nsIScriptError);
    if (showSrcInfo === undefined) showSrcInfo = true;
    if (stackLevel  === undefined) stackLevel  = 0;
    var info = showSrcInfo ? this.callerInfo(stackLevel+1) : new CallerInfo();
    err.init(this.PFX + txt, info.filename, info.sourceLine, info.lineNumber, info.columnNumber,
             err.errorFlag, "stylishsync");
    Services.console.logMessage(err);
    this._writeFile(err);
  },
  
};
