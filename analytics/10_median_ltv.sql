-- Median Buyer LTV in USDC
-- Counter widget: median lifetime spend per buyer

SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_spent) AS median_ltv
FROM (
  SELECT buyer, SUM(usdc_amount) AS total_spent
  FROM antseed_base.settlements
  GROUP BY buyer
) t
