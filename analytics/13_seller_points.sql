-- ============================================================================
-- AntSeed Seller Points 统计查询
-- 合约地址: 0xF13bE52c4A3afC6AE29536f073588d01A0564088 (Base Mainnet)
-- ============================================================================
--
-- SellerPointsAccrued(address indexed seller, uint256 indexed epoch, uint256 pointsDelta)
-- topic0 = 0xb463b4f6c3f2713f04717117455c27f0869dff33eec4100dc16519cd18e1be54
-- ============================================================================

WITH decoded_seller_points AS (
  SELECT
    *
  FROM
    TABLE (
      decode_evm_event (
        abi => '[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"seller","type":"address"},{"indexed":true,"internalType":"uint256","name":"epoch","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"pointsDelta","type":"uint256"}],"name":"SellerPointsAccrued","type":"event"}]',
        input => TABLE (
          SELECT
            *
          FROM
            base.logs
          WHERE
            contract_address = 0xF13bE52c4A3afC6AE29536f073588d01A0564088
            AND topic0 = 0xb463b4f6c3f2713f04717117455c27f0869dff33eec4100dc16519cd18e1be54
        )
      )
    )
),

seller_epoch_summary AS (
  SELECT
    seller,
    epoch,
    SUM(pointsDelta) AS total_points,
    COUNT(*) AS event_count,
    MIN(block_time) AS first_event_time,
    MAX(block_time) AS last_event_time,
    MIN(block_number) AS first_block,
    MAX(block_number) AS last_block
  FROM
    decoded_seller_points
  WHERE
    seller IS NOT NULL
  GROUP BY
    seller, epoch
)

SELECT
  seller,
  epoch,
  total_points,
  event_count,
  first_event_time,
  last_event_time,
  first_block,
  last_block,
  SUM(total_points) OVER (PARTITION BY seller ORDER BY epoch) AS cumulative_points_per_seller,
  SUM(total_points) OVER (PARTITION BY epoch) AS epoch_total_points,
  CAST(total_points * 100.0 / SUM(total_points) OVER (PARTITION BY epoch) AS DECIMAL(8,4)) AS points_share_in_epoch
FROM
  seller_epoch_summary
ORDER BY
  epoch DESC,
  total_points DESC
