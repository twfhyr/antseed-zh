-- Total Unique Paying Users
-- Counter widget: distinct buyers who have ever settled

SELECT
  COUNT(DISTINCT buyer) AS total_users
FROM antseed_base.settlements
