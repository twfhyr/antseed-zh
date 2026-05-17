-- Daily and Cumulative Volume in USDC
-- Area chart: USDC volume over time with running total

SELECT
  DATE(block_time) AS day,
  SUM(usdc_amount) AS daily_volume,
  SUM(SUM(usdc_amount)) OVER (ORDER BY DATE(block_time)) AS cumulative_volume
FROM antseed_base.settlements
GROUP BY DATE(block_time)
ORDER BY day
