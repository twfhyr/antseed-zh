-- ============================================================================
-- AntSeed Buyer Points 统计查询
-- 合约地址: 0xF13bE52c4A3afC6AE29536f073588d01A0564088 (Base Mainnet)
-- ============================================================================
--
-- Emissions V2 合约实际事件 (经链上验证):
--   1. BuyerPointsAccrued(address indexed buyer, uint256 indexed epoch, uint256 pointsDelta)
--      topic0 = 0xb6f182096ccbcdb01f88678850709e152446912df451858d3bdda2a5a02b46db
--   2. SellerPointsAccrued(address indexed seller, uint256 indexed epoch, uint256 pointsDelta)
--      topic0 = 0xb463b4f6c3f2713f04717117455c27f0869dff33eec4100dc16519cd18e1be54
--   3. BuyerEmissionsClaimed(address indexed caller, address indexed recipient, ...)
--      topic0 = 0x55dbb74b8ed455500bea764ff26f8559862d6dd3e6632f82fdbb88091f68a0e8
--   4. SellerEmissionsClaimed(address indexed caller, address indexed recipient, ...)
--      topic0 = 0xcf2009d50759437c9362a19e2512aa0160296153d63c36dfb6dacd1f83857baf
--
-- 注意: PairPointsAccrued 事件不存在于此合约。BuyerPointsAccrued 已经是
-- 最终的 credited buyer points (即 pair 结算后的结果), 无需从两个事件合并,
-- 否则会重复计算。
-- ============================================================================

-- 解码 BuyerPointsAccrued 事件
WITH decoded_buyer_points AS (
  SELECT
    *
  FROM
    TABLE (
      decode_evm_event (
        abi => '[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":true,"internalType":"uint256","name":"epoch","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"pointsDelta","type":"uint256"}],"name":"BuyerPointsAccrued","type":"event"}]',
        input => TABLE (
          SELECT
            *
          FROM
            base.logs
          WHERE
            contract_address = 0xF13bE52c4A3afC6AE29536f073588d01A0564088
            AND topic0 = 0xb6f182096ccbcdb01f88678850709e152446912df451858d3bdda2a5a02b46db
        )
      )
    )
),

-- 统计每个 buyer 在各 epoch 的累计 points
buyer_epoch_summary AS (
  SELECT
    buyer,
    epoch,
    SUM(pointsDelta) AS total_points,
    COUNT(*) AS event_count,
    MIN(block_time) AS first_event_time,
    MAX(block_time) AS last_event_time,
    MIN(block_number) AS first_block,
    MAX(block_number) AS last_block
  FROM
    decoded_buyer_points
  WHERE
    buyer IS NOT NULL
  GROUP BY
    buyer, epoch
)

-- 最终查询: 按 epoch 和 points 排序
SELECT
  buyer,
  epoch,
  total_points,
  event_count,
  first_event_time,
  last_event_time,
  first_block,
  last_block,
  SUM(total_points) OVER (PARTITION BY buyer ORDER BY epoch) AS cumulative_points_per_buyer,
  SUM(total_points) OVER (PARTITION BY epoch) AS epoch_total_points,
  CAST(total_points * 100.0 / SUM(total_points) OVER (PARTITION BY epoch) AS DECIMAL(8,4)) AS points_share_in_epoch
FROM
  buyer_epoch_summary
ORDER BY
  epoch DESC,
  total_points DESC
