import React, { useState, useEffect } from 'react';
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useBalance,
} from 'wagmi';
import {
  X,
  Loader2,
  AlertCircle,
  CheckCircle,
  ExternalLink,
} from 'lucide-react';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEPOSITS_ADDRESS = '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2';

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

const DEPOSITS_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
];

const USDC_DECIMALS = 6;

function parseUSDC(val) {
  if (!val || val === '') return 0n;
  const parts = val.split('.');
  const whole = parts[0] || '0';
  const frac = (parts[1] || '').padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  return BigInt(whole + frac);
}

function formatUSDC(wei) {
  if (!wei) return '0.00';
  const s = wei.toString().padStart(USDC_DECIMALS + 1, '0');
  const whole = s.slice(0, -USDC_DECIMALS) || '0';
  const frac = s.slice(-USDC_DECIMALS);
  return `${whole}.${frac}`;
}

const QUICK_AMOUNTS = [1, 5, 10, 50, 100];

function DepositModal({ isOpen, onClose }) {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState('idle');

  const { data: usdcBalance } = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: 8453,
  });

  const { data: allowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address, DEPOSITS_ADDRESS],
    chainId: 8453,
  });

  const {
    data: approveHash,
    isPending: isApproving,
    writeContract: approve,
  } = useWriteContract();

  const {
    isLoading: isApproveConfirming,
    isSuccess: isApproveConfirmed,
  } = useWaitForTransactionReceipt({ hash: approveHash });

  const {
    data: depositHash,
    isPending: isDepositing,
    writeContract: deposit,
  } = useWriteContract();

  const {
    isLoading: isDepositConfirming,
    isSuccess: isDepositConfirmed,
    isError: isDepositError,
  } = useWaitForTransactionReceipt({ hash: depositHash });

  const depositAmount = parseUSDC(amount);
  const currentAllowance = allowance ?? 0n;
  const needsApproval = depositAmount > 0n && depositAmount > currentAllowance;
  const walletBalance = usdcBalance ? usdcBalance.value : 0n;
  const exceedsBalance = depositAmount > walletBalance;
  const canDeposit = depositAmount > 0n && !needsApproval && !exceedsBalance;

  useEffect(() => {
    if (isApproveConfirmed && step === 'approving') {
      setStep('approved');
    }
  }, [isApproveConfirmed, step]);

  useEffect(() => {
    if (isDepositConfirmed && step === 'depositing') {
      setStep('done');
    }
    if (isDepositError && step === 'depositing') {
      setStep('idle');
    }
  }, [isDepositConfirmed, isDepositError, step]);

  const handleApprove = () => {
    setStep('approving');
    approve({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [DEPOSITS_ADDRESS, depositAmount],
    });
  };

  const handleDeposit = () => {
    setStep('depositing');
    deposit({
      address: DEPOSITS_ADDRESS,
      abi: DEPOSITS_ABI,
      functionName: 'deposit',
      args: [address, depositAmount],
    });
  };

  const handleClose = () => {
    setAmount('');
    setStep('idle');
    onClose();
  };

  const handleSetMax = () => {
    if (usdcBalance) {
      const formatted = parseFloat(usdcBalance.formatted);
      setAmount(formatted > 0 ? formatted.toString() : '0');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Deposit USDC</h2>
          <button className="modal-close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-desc">
            Deposit USDC to your buyer account on the AntSeed Deposits contract. This enables spending on inference services.
          </p>

          <div className="deposit-field">
            <div className="deposit-field__header">
              <label>Amount</label>
              <button className="deposit-field__max" onClick={handleSetMax}>
                Max: {usdcBalance ? parseFloat(usdcBalance.formatted).toFixed(2) : '0.00'} USDC
              </button>
            </div>
            <div className="deposit-field__input-wrap">
              <input
                type="number"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  if (step === 'approved') setStep('idle');
                }}
                placeholder="0.00"
                min="0"
                step="0.01"
                disabled={step === 'approving' || step === 'depositing'}
                className="deposit-field__input"
              />
              <span className="deposit-field__suffix">USDC</span>
            </div>
            <div className="deposit-field__quick">
              {QUICK_AMOUNTS.map((qa) => (
                <button
                  key={qa}
                  className="deposit-field__quick-btn"
                  onClick={() => {
                    setAmount(qa.toString());
                    if (step === 'approved') setStep('idle');
                  }}
                  disabled={step === 'approving' || step === 'depositing'}
                >
                  {qa}
                </button>
              ))}
            </div>
            {exceedsBalance && (
              <div className="deposit-field__error">
                <AlertCircle size={14} />
                Insufficient USDC balance
              </div>
            )}
          </div>

          <div className="deposit-info">
            <div className="deposit-info__row">
              <span>Wallet balance</span>
              <span>{usdcBalance ? parseFloat(usdcBalance.formatted).toFixed(2) : '—'} USDC</span>
            </div>
            <div className="deposit-info__row">
              <span>Current allowance</span>
              <span>{formatUSDC(currentAllowance)} USDC</span>
            </div>
            <div className="deposit-info__row">
              <span>Depositing to</span>
              <span className="deposit-info__mono">
                {DEPOSITS_ADDRESS.slice(0, 6)}...{DEPOSITS_ADDRESS.slice(-4)}
              </span>
            </div>
          </div>

          {step === 'done' ? (
            <div className="deposit-success">
              <CheckCircle size={20} style={{ color: 'var(--accent)' }} />
              <span>Deposit successful!</span>
              {depositHash && (
                <a
                  href={`https://basescan.org/tx/${depositHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="deposit-success__link"
                >
                  View tx <ExternalLink size={12} />
                </a>
              )}
            </div>
          ) : (
            <div className="deposit-actions">
              {needsApproval ? (
                <button
                  className="deposit-actions__btn"
                  onClick={handleApprove}
                  disabled={isApproving || isApproveConfirming || depositAmount === 0n}
                >
                  {isApproving || isApproveConfirming ? (
                    <><Loader2 size={16} className="spin" /> Approving...</>
                  ) : (
                    '1. Approve USDC'
                  )}
                </button>
              ) : (
                <button
                  className="deposit-actions__btn"
                  onClick={handleDeposit}
                  disabled={!canDeposit || isDepositing || isDepositConfirming}
                >
                  {isDepositing || isDepositConfirming ? (
                    <><Loader2 size={16} className="spin" /> Depositing...</>
                  ) : (
                    'Deposit USDC'
                  )}
                </button>
              )}

              {step === 'approving' && !isApproveConfirmed && (
                <p className="deposit-actions__hint">
                  Step 1 of 2: Approve USDC spending in your wallet...
                </p>
              )}
              {step === 'approved' && (
                <p className="deposit-actions__hint deposit-actions__hint--success">
                  <CheckCircle size={14} /> Approved! Now click Deposit.
                </p>
              )}
              {step === 'depositing' && !isDepositConfirmed && (
                <p className="deposit-actions__hint">
                  Step 2 of 2: Confirm deposit in your wallet...
                </p>
              )}
            </div>
          )}

          {approveHash && step === 'approving' && (
            <div className="deposit-tx-link">
              <a
                href={`https://basescan.org/tx/${approveHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Approve tx: {approveHash.slice(0, 10)}... <ExternalLink size={12} />
              </a>
            </div>
          )}
          {depositHash && step === 'depositing' && (
            <div className="deposit-tx-link">
              <a
                href={`https://basescan.org/tx/${depositHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Deposit tx: {depositHash.slice(0, 10)}... <ExternalLink size={12} />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DepositModal;
