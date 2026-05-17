-- Daily and Cumulative Inference Requests
-- Area chart: request count over time with running total

SELECT
  DATE(block_time) AS day,
  COUNT(*) AS daily_requests,
  SUM(COUNT(*)) OVER (ORDER BY DATE(block_time)) AS cumulative_requests
FROM antseed_base.settlements
GROUP BY DATE(block_time)
ORDER BY day
