// $Id$

"use strict";

const RSC        = "stylishsync";
const CMN        = "stsmodules";

const EXTMODULES = [ { rsc: RSC, mod: "stylishsync"}, { rsc: RSC, mod: "stsutils"}, 
                     { rsc: RSC, mod: "stsengine"},
                     { rsc: CMN, mod: "common/syncutils"},
                     { rsc: CMN, mod: "common/logutils"} ];

function startup(data, reason)
{
  setDefaultPrefs();
  Components.utils.import("chrome://"+RSC+"/content/stylishsync.jsm");
  StylishSync.startup(data, reason);
}

function shutdown(data, reason)
{
  Components.utils.import("chrome://"+RSC+"/content/stylishsync.jsm");
  StylishSync.shutdown(data, reason);
  
  EXTMODULES.forEach(function _unload(mod) {
    Components.utils.unload("chrome://"+mod.rsc+"/content/"+mod.mod+".jsm");
  });
}

function install(params, reason) {}

function uninstall(params, reason) {}


const DEFAULT_PREFS = {
  "extensions.stylishsync.debug":     false,
  "extensions.stylishsync.immediate": false,
  "extensions.stylishsync.autobak":   true,
  "extensions.stylishsync.bakage":    14,
  "extensions.stylishsync.stylish":   true,
  "extensions.stylishsync.version":   "",
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
