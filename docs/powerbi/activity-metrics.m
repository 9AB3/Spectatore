let
  // Spectatore - Power BI Activity Metrics
  // Replace BASE_URL and TOKEN as needed (or parameterize in Power BI).
  BASE_URL = "https://YOUR_RENDER_OR_SERVER_URL",
  TOKEN = "YOUR_TOKEN",
  FromDate = Date.ToText(Date.AddDays(Date.From(DateTime.LocalNow()), -30), "yyyy-MM-dd"),
  ToDate   = Date.ToText(Date.From(DateTime.LocalNow()), "yyyy-MM-dd"),
  Url = BASE_URL & "/api/powerbi/validated/activity-metrics?token=" & TOKEN & "&from=" & FromDate & "&to=" & ToDate,

  Raw = Json.Document(Web.Contents(Url, [Headers=[Accept="application/json"]])),
  T0  = Table.FromRecords(Raw),

  // Force stable types (prevents Power BI load showing blanks if it 'guesses' wrong types)
  Typed = Table.TransformColumnTypes(
    T0,
    {
      {"date", type datetime},
      {"date_ymd", type date},
      {"dn", type text},
      {"site", type text},
      {"user_id", Int64.Type},
      {"user_email", type text},
      {"user_name", type text},
      {"activity", type text},
      {"sub_activity", type text},
      {"equipment", type text},
      {"location", type text},
      {"from_location", type text},
      {"to_location", type text},
      {"source", type text},
      {"destination", type text},
      {"task_id", type text},
      {"task_row_id", Int64.Type},
      {"task_item_index", Int64.Type},
      {"task_item_type", type text},
      {"metric_key", type text},
      {"metric_text", type text},
      {"metric_value", type number}
    },
    "en-AU"
  )
in
  Typed
