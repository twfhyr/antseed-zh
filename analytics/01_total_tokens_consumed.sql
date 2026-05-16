-- Total Tokens Consumed
-- Counter widget on AntSeed dashboard
-- Sums all input + output tokens from settlement events

SELECT
    SUM(CAST(input_tokens AS BIGINT) + CAST(output_tokens AS BIGINT)) AS total_tokens
FROM antseed_base.settlements
