import React, { useState } from 'react';
import {
useAccount,
useWriteContract,
useWaitForTransactionReceipt,
} from 'wagmi';
import {
X,
Loader2,
AlertCircle,
CheckCircle,
ExternalLink,
} from 'lucide-react';

const DEPOSITS_ADDRESS = '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2';

const DEPOSITS_WITHDRAW_ABI = [
{
name: 'withdraw',
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

const QUICK_AMOUNTS = [1, 5, 10, 50];

function WithdrawModal({ isOpen, onClose, balance, buyerAddress }) {
const { address, isConnected } = useAccount();
const [amount, setAmount] = useState('');
const [step, setStep] = useState('idle');
const withdrawTarget = buyerAddress ?? address;

const {
data: withdrawHash,
isPending: isWithdrawing,
writeContract: withdraw,
} = useWriteContract();

const {
isLoading: isConfirming,
isSuccess: isConfirmed,
isError: isError,
} = useWaitForTransactionReceipt({ hash: withdrawHash });

const availableAmount = balance ? parseFloat(balance.available) : 0;
const withdrawAmount = parseUSDC(amount);
const exceedsBalance = withdrawAmount > 0n && parseFloat(amount) > availableAmount;
  const canWithdraw = withdrawAmount > 0n && !exceedsBalance && withdrawTarget;

  const handleWithdraw = () => {
    setStep('withdrawing');
    withdraw({
      address: DEPOSITS_ADDRESS,
      abi: DEPOSITS_WITHDRAW_ABI,
      functionName: 'withdraw',
      args: [withdrawTarget, withdrawAmount],
    });
  };

const handleClose = () => {
setAmount('');
setStep('idle');
onClose();
};

if (!isOpen) return null;

return (
<div className="modal-overlay" onClick={handleClose}>
<div className="modal-content" onClick={(e) => e.stopPropagation()}>
<div className="modal-header">
<h2>Withdraw USDC</h2>
<button className="modal-close" onClick={handleClose}>
<X size={18} />
</button>
</div>

<div className="modal-body">
<p className="modal-desc">
Withdraw USDC from your buyer account on the Deposits contract. Funds are sent to your connected wallet.
</p>

<div className="deposit-field">
<div className="deposit-field__header">
<label>Amount</label>
<button
className="deposit-field__max"
onClick={() => setAmount(availableAmount > 0 ? availableAmount.toString() : '0')}
>
Max: {availableAmount.toFixed(2)} USDC
</button>
</div>
<div className="deposit-field__input-wrap">
<input
type="number"
value={amount}
onChange={(e) => {
setAmount(e.target.value);
if (step === 'done') setStep('idle');
}}
placeholder="0.00"
min="0"
step="0.01"
disabled={step === 'withdrawing'}
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
if (step === 'done') setStep('idle');
}}
disabled={step === 'withdrawing' || qa > availableAmount}
>
{qa}
</button>
))}
</div>
{exceedsBalance && (
<div className="deposit-field__error">
<AlertCircle size={14} />
Exceeds available balance
</div>
)}
</div>

<div className="deposit-info">
<div className="deposit-info__row">
<span>Available</span>
<span>{availableAmount.toFixed(2)} USDC</span>
</div>
<div className="deposit-info__row">
<span>Reserved</span>
<span>{balance ? parseFloat(balance.reserved).toFixed(2) : '0.00'} USDC</span>
</div>
      <div className="deposit-info__row">
        <span>Withdrawing to</span>
        <span className="deposit-info__mono">
          {withdrawTarget ? `${withdrawTarget.slice(0, 6)}...${withdrawTarget.slice(-4)}` : '—'}
        </span>
      </div>
</div>

{step === 'done' || isConfirmed ? (
<div className="deposit-success">
<CheckCircle size={20} style={{ color: 'var(--accent)' }} />
<span>Withdrawal successful!</span>
{withdrawHash && (
<a
href={`https://basescan.org/tx/${withdrawHash}`}
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
<button
className="deposit-actions__btn"
onClick={handleWithdraw}
disabled={!canWithdraw || isWithdrawing || isConfirming}
>
{isWithdrawing || isConfirming ? (
<><Loader2 size={16} className="spin" /> Withdrawing...</>
) : (
'Withdraw USDC'
)}
</button>
{step === 'withdrawing' && !isConfirmed && (
<p className="deposit-actions__hint">
Confirm withdrawal in your wallet...
</p>
)}
</div>
)}

{isError && (
<div className="deposit-field__error" style={{ marginTop: '0.75rem' }}>
<AlertCircle size={14} />
Transaction failed or was rejected
</div>
)}
</div>
</div>
</div>
);
}

export default WithdrawModal;
