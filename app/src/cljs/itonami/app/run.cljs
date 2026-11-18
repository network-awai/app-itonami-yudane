(ns itonami.app.run
  "Shared runner for itonami apps whose logic is the repo's own .cljk domain
  (AWAI-3502). An app's entry namespace registers actions; the page calls
  `actions` and `run`. Input and output are EDN text. Nothing here does I/O:
  no network, no storage, no clock beyond what an action passes in."
  (:require [cljs.pprint :as pp]
            [cljs.reader :as reader]
            [clojure.string :as str]))

(defonce registry (atom []))

(defn register!
  "Add an action: {:name :label :help :example (EDN text) :run (fn [input] ...)}.
  With :raw true the action receives the text itself instead of the EDN it reads as
  (for repos that parse their own seed format)."
  [action]
  (swap! registry conj action))

(defn ^:export actions []
  (clj->js (mapv #(select-keys % [:name :label :help :example]) @registry)))

(defn ^:export run
  "Run one registered action on EDN text. Returns #js {:edn <pretty-printed result>}."
  [action-name text]
  (let [action (some #(when (= action-name (:name %)) %) @registry)
        _ (when-not action (throw (js/Error. (str "unknown action: " action-name))))
        input (cond (:raw action) text
                    (str/blank? text) nil
                    :else (reader/read-string text))
        out ((:run action) input)]
    #js {:edn (with-out-str (pp/pprint out))}))
