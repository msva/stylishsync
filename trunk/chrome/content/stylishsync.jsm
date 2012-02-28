// $Id$

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("chrome://stylishsync/content/syncutils.jsm");
Components.utils.import("chrome://stylishsync/content/logutils.jsm");
Components.utils.import("chrome://stylishsync/content/stsutils.jsm");
Components.utils.import("chrome://stylishsync/content/stsengine.jsm");
Components.utils.import("resource://services-sync/main.js");

var EXPORTED_SYMBOLS = [ "StylishSync" ];

//*****************************************************************************
//* Main class
//*****************************************************************************

var StylishSync = {

  SYNC_ENGINE: "stylishsync",
  
  data:     null,
  stylish:  null,
  strings:  null,
  window:   null,

  startup: function STS_startup(data, reason) {
    try {
      this.data = data;
      Services.strings.flushBundles();
      this.strings = new SyncStringBundle(this.SYNC_ENGINE);
    
      if (reason == 1) Services.obs.addObserver(this, "weave:service:ready",  false);
      else             this.startEngine();

      Services.obs  .addObserver(this, "addon-options-displayed", false);
      Services.prefs.addObserver("extensions.stylishsync.stylish", this, false);
      this.handleStylishSettings();
      Logging.debug("startup: " + reason);
    } catch (exc) {
      Logging.logException(exc);
      throw(exc);
    }
  },
  
  shutdown: function STS_shutdown(data, reason) {
    try {
      let engine = Weave.Engines.get(this.SYNC_ENGINE);
      Logging.debug("unregistering '"+(engine?engine.Name:"<not found>")+"'");
    
      if (engine) { 
        engine.shutdown();
        Weave.Engines.unregister(engine);
      }

      try { Services.obs  .removeObserver(this, "addon-options-displayed"); } catch (exc) {}
      try { Services.prefs.removeObserver("extensions.stylishsync.stylish", this); } catch (exc) {}
    
      Logging.debug("shutdown: " + reason);
    } catch (exc) {
      Logging.logException(exc);
      throw(exc);
    }
  },
  
  observe: function STS_observe(subject, topic, data) {
    try {
      Logging.debug("STS_observe: " + subject + ", " + topic);

      switch (topic) {
        case "weave:service:ready":
          Services.obs.removeObserver(this, "weave:service:ready");
          this.startEngine();
          break;

        case "addon-options-displayed":
          if (this.data && data == this.data.id)
            this.handleOptions(subject);
          break;
        
        case "nsPref:changed":
          if (data == "extensions.stylishsync.stylish")
            this.handleStylishSettings();
          break;
      }
    } catch (exc) {
      Logging.logException(exc);
      throw(exc);
    }
  },
  
  startEngine: function STS_startEngine() {
    try { this.stylish = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle); }
    catch (exc) {}
    
    if (this.stylish === null) {
      Logging.warn("Stylish doesn't seem to be installed. Exiting.");
      return;
    }

    this.migrate();

    if (!SyncUtil.lockWeave(10000)) {
      Logging.error("Cannot lock sync service. Engine not registered.");
      return;
    }

    try {

      Weave.Engines.register(StylishSyncEngine);
      Logging.debug("Engine registered.");
        
      let backup = Services.prefs.getBoolPref("extensions.stylishsync.autobak");
      
      if (this.isFirstStart()) {
        Logging.debug("First start");
        StylishBackup.firstStart(this, backup);
        StsUtil.promptAndSync(null, this.SYNC_ENGINE);
      } else
        if (backup) StylishBackup.backup(this);
      
    } finally {
      Weave.Service.unlock();
    }
  },  

  handleOptions: function STS_handleOptions(doc) {
    let self    = this;
    let reset   = doc.getElementById("stsreset-btn");
    let backup  = doc.getElementById("stsbackup-btn");
    let restore = doc.getElementById("stsrestore-btn");
    let name    = this.strings.get("stylishsync");

    if (Weave.Engines.get(this.SYNC_ENGINE)) {
      // Show Reset Dialog
      reset.addEventListener("command", function STS_onResetButton() {
         StsUtil.promptAndSync(doc.defaultView, self.SYNC_ENGINE, "resetPrompt", "keepPrompt");
      }, false);
      // Create Backup
      backup.addEventListener("command", function STS_onBackupButton() {
         self.window = doc.defaultView;
         let rc = StylishBackup.backup(self, true);
         if (rc == StylishBackup.FAILED)
           Services.prompt.alert(self.window, name, self.strings.get("backupError"));
         self.window = null;
      }, false);
      // Restore Database
      restore.addEventListener("command", function STS_onRestoreButton() {
         self.window = doc.defaultView;
         let rc = StylishBackup.restore(self, null);
         if (rc == StylishBackup.OK)
           StsUtil.promptAndSync(doc.defaultView, self.SYNC_ENGINE, "restoredPrompt");
         else if (rc == StylishBackup.FAILED)
           Services.prompt.alert(self.window, name, self.strings.get("restoreError"));
         self.window = null;
      }, false);
    } else { // engine not (yet) registered, disable controls
      [ "stsenabled-set", "stsimmediate-set", "stsmanage-set", "stsautobak-set",
        "stsreset-btn",   "stsbackup-btn",    "stsrestore-btn" ].forEach(function(id){
        doc.getElementById(id).setAttribute("disabled", "true");
      });
    }
  },  

  handleStylishSettings: function STS_handleStylishSettings() {
    const STYLISH_SETTINGS = [ 
      "closedContainers", "editOnInstall", "editor", "install.allowedDomains",
      "manageView", "styleRegistrationEnabled", "updatesEnabled", "wrap_lines"
    ];
    let sync = Services.prefs.getBoolPref("extensions.stylishsync.stylish");
    let pfx  = "services.sync.prefs.sync.extensions.stylish.";

    STYLISH_SETTINGS.forEach(function(pref) {
      if (sync) Services.prefs.setBoolPref(pfx + pref, "true");
      else      Services.prefs.clearUserPref(pfx + pref);
    });
  },
  
  migrate: function STS_migrate() {
    if (!this.stylish) return; // nevermind
    
    let ver  = Services.prefs.getCharPref("extensions.stylishsync.version").split(".");
    if (!(ver < this.data.version.split("."))) return;
    let mig = true;
    
    if (ver < [0,1,0]) {
      // Fix duplicate metas from 0.0.2
      StsUtil.fixDuplicateMetas(this.stylish);
      // Set default backup directory
      StylishBackup.firstStart(this, false);
    } else
      mig = false;
      
    Services.prefs.setCharPref("extensions.stylishsync.version", this.data.version);

    if (mig) Logging.debug("Migrated: '"+ver+"' -> '"+this.data.version+"'");
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
