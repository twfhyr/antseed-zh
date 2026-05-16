import React from 'react';
import { Users, Server, DollarSign, Activity, Zap } from 'lucide-react';

const icons = {
  buyers: Users,
  sellers: Server,
  services: Zap,
  volume: DollarSign,
  transactions: Activity,
};

const colors = {
  buyers: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' },
  sellers: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981' },
  services: { bg: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4' },
  volume: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' },
  transactions: { bg: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6' },
};

function StatsCards({ stats }) {
  const cards = [
    { key: 'buyers', title: 'Total Buyers', value: stats.totalBuyers, change: `+${stats.buyerGrowth}%` },
    { key: 'sellers', title: 'Total Sellers', value: stats.totalSellers, change: `+${stats.sellerGrowth}%` },
    { key: 'services', title: 'Total Services', value: stats.totalServices, change: `+${stats.serviceGrowth}%` },
    { key: 'volume', title: 'Total Volume', value: `$${stats.totalVolume.toLocaleString()}`, change: `+${stats.volumeGrowth}%` },
    { key: 'transactions', title: 'Active Transactions', value: stats.activeTransactions.toLocaleString(), change: `+${stats.transactionGrowth}%` },
  ];

  return (
    <div className="stats-grid">
      {cards.map((card) => {
        const Icon = icons[card.key];
        const color = colors[card.key];
        return (
          <div key={card.key} className="stat-card">
            <div className="stat-header">
              <span className="stat-title">{card.title}</span>
              <div className="stat-icon" style={{ background: color.bg }}>
                <Icon size={20} color={color.color} />
              </div>
            </div>
            <div className="stat-value">{card.value}</div>
            <div className="stat-change">{card.change} from last month</div>
          </div>
        );
      })}
    </div>
  );
}

export default StatsCards;