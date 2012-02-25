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
  "extensions.stylishsync.debug":     false,
  "extensions.stylishsync.immediate": false,
  "extensions.stylishsync.autobak":   true,
  "extensions.stylishsync.bakage":    14,
  "services.sync.engine.stylishsync": true,
  "services.sync.prefs.sync.extensions.stylishsync.immediate": true,
  "services.sync.prefs.sync.extensions.stylishsync.autobak":   true,
  "services.sync.prefs.sync.extensions.stylishsync.bakage":    true
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
