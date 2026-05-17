-- Operator-to-Buyer Address Mapping
-- Deposits contract: 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2
-- Event: OperatorSet(address indexed buyer, address indexed operator)
-- topic0 = 0xfd489696792cc4c5d5b226c46f008e459c8ec9b746c49191d74bb92c19fd1867

SELECT
  *
FROM
  TABLE (
    decode_evm_event (
      abi => '[{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"buyer","type":"address"},{"indexed":true,"internalType":"address","name":"operator","type":"address"}],"name":"OperatorSet","type":"event"}]',
      input => TABLE (
        SELECT
          *
        FROM
          base.logs
        WHERE
          contract_address = 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2
          AND topic0 = 0xfd489696792cc4c5d5b226c46f008e459c8ec9b746c49191d74bb92c19fd1867
      )
    )
  )
ORDER BY block_time DESC
