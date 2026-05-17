-- Monthly Active Paying Users
-- Bar chart: unique buyers per calendar month

SELECT
  DATE_TRUNC('month', block_time) AS month,
  COUNT(DISTINCT buyer) AS mau
FROM antseed_base.settlements
GROUP BY DATE_TRUNC('month', block_time)
ORDER BY month
