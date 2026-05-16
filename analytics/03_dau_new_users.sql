-- Daily Active Paying Users & New Users
-- Bar chart (DAU) + line chart (new users)

WITH daily_buyers AS (
    SELECT
        DATE(block_time) AS day,
        buyer
    FROM antseed_base.settlements
),
first_spend AS (
    SELECT
        buyer,
        MIN(day) AS first_day
    FROM daily_buyers
    GROUP BY buyer
)
SELECT
    d.day,
    COUNT(DISTINCT d.buyer) AS dau,
    COUNT(DISTINCT CASE WHEN f.first_day = d.day THEN d.buyer END) AS new_users
FROM daily_buyers d
LEFT JOIN first_spend f ON d.buyer = f.buyer
GROUP BY d.day
ORDER BY d.day
