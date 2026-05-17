-- Average Buyer LTV in USDC
-- Counter widget: mean lifetime spend per buyer

SELECT
  AVG(total_spent) AS avg_ltv
FROM (
  SELECT buyer, SUM(usdc_amount) AS total_spent
  FROM antseed_base.settlements
  GROUP BY buyer
) t
