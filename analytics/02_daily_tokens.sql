-- Daily Token Consumption
-- Area chart: daily token consumption over time

SELECT
    DATE(block_time) AS day,
    SUM(CAST(input_tokens AS BIGINT) + CAST(output_tokens AS BIGINT)) AS total_tokens
FROM antseed_base.settlements
GROUP BY DATE(block_time)
ORDER BY day
