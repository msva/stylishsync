// $Id$

"use strict";

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("chrome://stylishsync/content/stsutils.jsm");
Components.utils.import("resource://services-sync/engines.js");
Components.utils.import("resource://services-sync/record.js");
Components.utils.import("resource://services-sync/util.js");
Components.utils.import("resource://services-sync/main.js");
Components.utils.import("resource://services-sync/constants.js");

var EXPORTED_SYMBOLS = [ "StylishSyncEngine", "StylishSyncRecord", "StylishConst" ];

var trackerInstance = null;

let assert = StsUtil.assert;

//*****************************************************************************
//* Helpers
//*****************************************************************************
function dbgFmt(obj) {
  if (!Logging.DEBUG) return "";
  let snip = function(key, value) { return (key == "code") ? value.substring(0, 256) : value; }
  return JSON.stringify(obj, snip);
}


//*****************************************************************************
//* Custom Sync Engine classes
//*****************************************************************************

const STYLE_PROPS = [
  "url",  "idUrl",   "updateUrl", "md5Url", "name",
  "code", "enabled", "originalCode"
];

const STYLE_META = [ "url", "url-prefix", "domain", "regexp", "type", "tag" ];
const STYLISH_MODE_SYNCING  = 1024;
var   STYLISH_MODE_FOR_SYNC = 4; // REGISTER_STYLE_ON_LOAD: we don't know if stylish is already loaded, so fix it later
                                 // HACK ALERT: we're fixing this in the engine's constructor! Should be a deferred value!
                                 // assume values present, not: this.svc.CALCULATE_META

const StylishConst = {
  STYLE_PROPS:           STYLE_PROPS,
  STYLE_META:            STYLE_META,
  STYLISH_MODE_SYNCING:  STYLISH_MODE_SYNCING,
  STYLISH_MODE_FOR_SYNC: STYLISH_MODE_FOR_SYNC
};

function StyleWrapper(guid, styleobj) {
  this.svc   = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle);
  this.guid  = guid;
  this.style = null;
  if (guid) {
    let styles = this.svc.findByMeta("syncguid", guid, STYLISH_MODE_FOR_SYNC, {});
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
    this.style.mode = 0; // assume we've got all values
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
        StsUtil.unique(rec.meta[name]).forEach(function (val) {
          self.style.addMeta(name, val)
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
      if (m && m.length > 0) rec.meta[name] = StsUtil.unique(m);
    });
  }
  
};

StyleWrapper = StsUtil.errorLoggedClass(StyleWrapper);

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
    Logging.debug("createRecord: "+id+", "+coll+", "+dbgFmt(wrap));
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
    let styles = this.svc.list(STYLISH_MODE_FOR_SYNC, {});
    let guids  = {};
    for (let s in styles) {
      let wrap = new StyleWrapper(null, styles[s]);
      guids[wrap.guid] = true;
    }
    return guids;
  },
  
  wipe: function STS_wipe() {
    Logging.debug("wipe");
    let styles = this.svc.list(STYLISH_MODE_FOR_SYNC, {});
    for (let s in styles)
      new StyleWrapper(null, styles[s]).delete();
    let conn = null;
    try {
      let data = Components.classes["@userstyles.org/stylish-data-source;1"].createInstance(Components.interfaces.stylishDataSource);
      conn = data.getConnection();
      conn.executeSimpleSQL("delete from sqlite_sequence where name in ('styles', 'style_meta')");
    } finally {
      if (conn) conn.close();
    }
    Logging.debug("wipe done");
  },
  
  create: function STS_create(rec) {
    return this.update(rec);
  },
  
  update: function STS_update(rec) {
    Logging.debug("update: "+dbgFmt(rec.cleartext));
    let wrap = new StyleWrapper(rec.id);
    wrap.fromRecord(rec);
    if (wrap.style.name != null)
      wrap.save();
    else
      Logging.debug("update tried to save null name...");
  },
  
  remove: function STS_remove(rec) {
    Logging.debug("remove: "+dbgFmt(rec));
    let wrap = new StyleWrapper(rec.id);
    if (wrap.style.id != 0)
      wrap.delete();
  },
};

StylishSyncStore   = StsUtil.errorLoggedClass(StylishSyncStore);

function StylishSyncTracker(name) {
  Tracker.call(this, name);
  // Because we're in a bootstrapped addon, we won't get
  // weave:engine:start-tracking at first, but maybe on a sync start-over
  // so start tracking immediately and 
  this.startTracking();
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
        this.stopTracking();
        break;
        
      case "weave:engine:start-tracking":
        Services.obs.removeObserver(this, "weave:engine:start-tracking");
        this.startTracking();
        break;
    }
  },
  
  
  startTracking: function STT_startTracking() {
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
  },    
  
  stopTracking: function STT_stopTracking(shutdown) {
    if (trackerInstance) {
      Services.obs.removeObserver(this, "stylish-style-add");
      Services.obs.removeObserver(this, "stylish-style-change");
      Services.obs.removeObserver(this, "stylish-style-delete");
      Services.obs.removeObserver(this, "weave:engine:stop-tracking");
      trackerInstance = null;
      Logging.debug("StylishSyncTracker singleton deleted");
      // now, we can start listening again
      if (!shutdown)
        Services.obs.addObserver(this, "weave:engine:start-tracking", false);
    }
  }
  
};

StylishSyncTracker = StsUtil.errorLoggedClass(StylishSyncTracker);

function StylishSyncEngine() {
  try {
    Weave.SyncEngine.call(this, "StylishSync");
    this.svc     = Components.classes["@userstyles.org/style;1"].getService(Components.interfaces.stylishStyle);
    this.strings = new SyncStringBundle();
    // HACK ALERT: this should be deferred value
    STYLISH_MODE_FOR_SYNC = this.svc.REGISTER_STYLE_ON_LOAD;
  } catch (exc) {
    Logging.logException(exc);
    throw(exc);
  }
}

StylishSyncEngine.prototype = {
  __proto__:   Weave.SyncEngine.prototype,
  _recordObj:  StylishSyncRecord,
  _storeObj:   StylishSyncStore,
  _trackerObj: StylishSyncTracker,

  _findDupe: function STE_findDupe(rec) {
    Logging.debug("_findDupe: "+dbgFmt(rec.cleartext));
    let styles = this.svc.list(STYLISH_MODE_FOR_SYNC, {});
    for (let s in styles) {
      let wrap = new StyleWrapper(null, styles[s]);
      if (wrap.guid && wrap.name == rec.name && wrap.code.trim() == rec.code.trim())
        return wrap.guid;
      if (wrap.name == rec.name) { // Don't know if this is legal but technically, we don't change anytinh pertaining to sync
        wrap.style.addMeta("tag", this.strings.get("overwrittenTag"));
        wrap.save();
      }
    }
    return null;
  },
  
  shutdown: function STE_shutdown() {
    if (this.trackerInstance) this.trackerInstance.stopTracking(true);
  },
  
  get trackerInstance() {
    return trackerInstance;
  }
};

// FIXME: StylishSyncEngine = StsUtil.errorLoggedClass(StylishSyncEngine);
