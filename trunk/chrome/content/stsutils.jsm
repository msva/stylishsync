// $Id$

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/FileUtils.jsm");
Components.utils.import("resource://gre/modules/DownloadLastDir.jsm");  
Components.utils.import("resource://gre/modules/PopupNotifications.jsm");
Components.utils.import("resource://services-sync/main.js");

var EXPORTED_SYMBOLS = [ "SyncError", "StylishBackup", "Logging", "assert" ];

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

function assert(cond, txt)
{
  if (!cond)
    throw new SyncError(txt||"Assertion Error", 1);
}

//*****************************************************************************
//* Backup / Restore
//*****************************************************************************
// TODO: refactor engine to its own module
const STYLISH_MODE_SYNCING = 1024;

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
      
      stmt = conn.createStatement("select s.*, m.name as meta, m.value as mval "+
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
          style.mode = STYLISH_MODE_SYNCING | stylish.CALCULATE_META | stylish.REGISTER_STYLE_ON_CHANGE;
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
    let FP     = Components.interfaces.nsIFilePicker;
    let picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(FP);

    picker.init(sts.window, name+" - "+title, restore ? FP.modeOpen : FP.modeSave);
    picker.appendFilter(name, "stylish" + (restore ? "": "sync") + "*.sqlite");
    picker.appendFilters(FP.filterAll);

    picker.displayDirectory = gDownloadLastDir.getFile("chrome://stylishsync");
    picker.defaultString    = "stylishsync.sqlite";
    
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
