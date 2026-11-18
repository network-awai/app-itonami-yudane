(ns kotoba.lang.edn
  "App-side shim for the ClojureScript build only (AWAI-3502). The repo's .cljk
  code calls kotoba.lang.edn/read-string; the pinned kotoba.lang.edn needs
  kotoba.bytes and has no ClojureScript branches, so in the browser build this
  namespace reads EDN with cljs.reader instead. Only read-string is provided: a
  call to anything else is a compile warning, which fails the build."
  (:refer-clojure :exclude [read-string])
  (:require [cljs.reader :as reader]))

(defn read-string
  ([s] (reader/read-string s))
  ([opts s] (reader/read-string opts s)))
