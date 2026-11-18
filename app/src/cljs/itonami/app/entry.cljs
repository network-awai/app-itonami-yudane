(ns itonami.app.entry
  "Yudane on the device (AWAI-3502). Calls yudane.methods.analyze unchanged:
  consent verdicts and aggregate flexibility only, never per-person data, and
  never a dispatch. Example offers are from the repo's seed."
  (:require [itonami.app.run :as run]
            [yudane.methods.analyze :as a]))

(def ^:private example-offers
  "{:offers
 [{:id \"presence-wfh-01\" :name \"WFH-day cohort -> HVAC pre-conditioning\" :intent-class :presence-shift
   :capability \"cap:cohort-a:datom-transact@graph:yudane\" :cap-expiry-h 24 :reciprocal true
   :cohort-size 40 :flex-kwh 2600}
  {:id \"schedule-office-01\" :name \"Known office-vacancy schedule -> setback\" :intent-class :schedule-known
   :capability \"cap:cohort-c:datom-transact@graph:yudane\" :cap-expiry-h 6 :reciprocal true
   :cohort-size 3 :flex-kwh 900}
  {:id \"defer-laundry-01\" :name \"Deferrable home loads -> surplus window\" :intent-class :defer-flexible
   :capability \"\" :cap-expiry-h 12 :reciprocal true :cohort-size 120 :flex-kwh 4100}]}")

(run/register!
 {:name "verdict" :label "申し出を判定する"
  :help "申し出ごとに同意の判定を返します。能力がない・期限切れ・互恵でない・5 人未満の集団は、それぞれの理由で退けます。"
  :example example-offers
  :run (fn [{:keys [offers]}] (mapv (fn [o] {:id (:id o) :verdict (a/verdict o) :route (a/route (a/verdict o))}) offers))})

(run/register!
 {:name "analyze" :label "集計する"
  :help "同意した申し出の柔軟性だけを集計します。退けた申し出の量は 0 として数えます。"
  :example example-offers
  :run (fn [{:keys [offers]}] (a/analyze offers))})

(run/register!
 {:name "report" :label "報告を作る"
  :help "集計と網羅状況から Markdown の報告を作ります。"
  :example example-offers
  :run (fn [{:keys [offers]}] (a/render-report (a/analyze offers) (a/coverage offers)))})
