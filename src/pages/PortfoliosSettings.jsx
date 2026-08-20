import React, { useState } from 'react';
import { ArrowLeft, Plus, Edit2, Trash2, X, Briefcase } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../context/DataContext';
import './ManageData.css';

export default function PortfoliosSettings() {
  const navigate = useNavigate();
  const { portfolios, savePortfolio, deletePortfolio } = useData();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  
  const [name, setName] = useState('');
  const [color, setColor] = useState('#10b981');

  const openModal = (item = null) => {
    setEditingItem(item);
    if (item) {
      setName(item.name || '');
      setColor(item.color || '#10b981');
    } else {
      setName('');
      setColor('#10b981');
    }
    setModalOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;

    const payload = {
      id: editingItem ? editingItem.id : null,
      name: name.trim(),
      color,
      icon: 'Briefcase'
    };

    await savePortfolio(payload);
    setModalOpen(false);
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this portfolio? Transactions linked to it may be affected.')) {
      await deletePortfolio(id);
    }
  };

  return (
    <div className="page-container manage-data-page">
      <div className="manage-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="Go back">
          <ArrowLeft size={24} />
        </button>
        <h1>Manage Portfolios</h1>
      </div>

      <div className="manage-content">
        <button className="add-item-btn" onClick={() => openModal()}>
          <Plus size={20} /> Add Portfolio
        </button>

        <div className="data-item-list">
          {portfolios.length === 0 ? (
            <div className="empty-state">No portfolios found. Create one to get started.</div>
          ) : (
            portfolios.map(item => (
              <div key={item.id} className="data-item-card">
                <div className="item-info">
                  <div className="item-icon-wrap" style={{ backgroundColor: item.color }}>
                    <Briefcase size={20} />
                  </div>
                  <div className="item-details">
                    <span className="item-name">{item.name}</span>
                  </div>
                </div>
                <div className="item-actions">
                  <button className="action-btn edit" onClick={() => openModal(item)}>
                    <Edit2 size={18} />
                  </button>
                  <button className="action-btn delete" onClick={() => handleDelete(item.id)}>
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {modalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(20,20,25,0.95)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <form onSubmit={handleSave} className="glass-panel" style={{ padding: '32px', display: 'flex', flexDirection: 'column', width: '90%', maxWidth: '340px', borderRadius: '24px', position: 'relative' }}>
            <button 
              type="button" 
              onClick={() => setModalOpen(false)} 
              style={{ position: 'absolute', top: '16px', right: '16px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              <X size={20} />
            </button>
            <h2 style={{ marginTop: 0, marginBottom: '24px', fontSize: '20px' }}>
              {editingItem ? 'Edit Portfolio' : 'New Portfolio'}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: 'var(--text-secondary)' }}>Name</label>
                <input 
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{ width: '100%', padding: '12px 16px', borderRadius: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', fontSize: '16px' }}
                  placeholder="e.g. Long Term, Trading"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: 'var(--text-secondary)' }}>Color</label>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {['#ef4444', '#f97316', '#f59e0b', '#10b981', '#0ea5e9', '#10b981', '#10b981', '#ec4899'].map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      style={{
                        width: '32px', height: '32px', borderRadius: '50%', backgroundColor: c,
                        border: color === c ? '3px solid white' : '2px solid transparent',
                        cursor: 'pointer'
                      }}
                    />
                  ))}
                </div>
              </div>

              <button type="submit" className="submit-btn bg-primary" style={{ marginTop: '16px' }}>
                Save Portfolio
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
