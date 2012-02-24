// $Id$

"use strict";

function startup(data, reason)
{
  setDefaultPrefs();
  Components.utils.import("chrome://stylishsync/content/stylishsync.jsm");
  StylishSync.startup(data, reason);
}

function shutdown(data, reason)
{
  Components.utils.import("chrome://stylishsync/content/stylishsync.jsm");
  StylishSync.shutdown(data, reason);
  
  Components.utils.unload("chrome://stylishsync/content/stylishsync.jsm");
  Components.utils.unload("chrome://stylishsync/content/stsutils.jsm");
}

function install(params, reason) {}

function uninstall(params, reason) {}


const DEFAULT_PREFS = {
  "services.sync.engine.stylishsync": true,
  "extensions.stylishsync.debug":     false,
  "extensions.stylishsync.immediate": false,
  "services.sync.prefs.sync.extensions.stylishsync.immediate": true
};

function setDefaultPrefs() {
  Components.utils.import("resource://gre/modules/Services.jsm");
  let branch = Services.prefs.getDefaultBranch("");
  for (let [key, val] in Iterator(DEFAULT_PREFS)) {
    switch (typeof val) {
      case "boolean": branch.setBoolPref(key, val); break;
      case "number":  branch.setIntPref(key,  val); break;
      case "string":  branch.setCharPref(key, val); break;
    }
  }
}
