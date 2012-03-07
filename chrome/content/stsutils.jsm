// $Id$

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/FileUtils.jsm");
Components.utils.import("resource://gre/modules/DownloadLastDir.jsm");  
Components.utils.import("resource://gre/modules/PopupNotifications.jsm");
Components.utils.import("resource://services-sync/main.js");
Components.utils.import("chrome://stsmodules/content/common/syncutils.jsm");
Components.utils.import("chrome://stsmodules/content/common/logutils.jsm");

var EXPORTED_SYMBOLS = [ "SyncError", "StylishBackup", "SyncStringBundle",
                         "StsUtil",  "Logging" ];

//*****************************************************************************
//* Helpers
//*****************************************************************************
// FIXME: Subclass?
var StsUtil = SyncUtil;

StsUtil.fixDuplicateMetas = function STU_fixDuplicateMetas(stylish) {
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
};

//*****************************************************************************
//* Backup / Restore
//*****************************************************************************

const assert = SyncUtil.assert;

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
        let  maxAge = Services.prefs.getIntPref("extensions.stylishsync.bakage") * 24 * 3600 * 1000;
        file = SyncUtil.makeBackupFile(this.bakdir, "stylishsync", ".sqlite", maxAge);
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
          style.mode = StylishConst.STYLISH_MODE_SYNCING | stylish.REGISTER_STYLE_ON_LOAD | stylish.REGISTER_STYLE_ON_CHANGE;
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
Logging.CATEGORY     = "stylishsync";
Logging.PFX          = Logging.CATEGORY+": ";
Logging.DEBUG        = Services.prefs.getBoolPref("extensions.stylishsync.debug");
Logging.LOGFILE_PREF = "extensions.stylishsync.logfile";

SyncUtil.setLogging(Logging);
