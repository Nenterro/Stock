import React, { createContext, useContext, useState, useEffect } from 'react';
import localforage from 'localforage';

const TransactionContext = createContext();

export const useTransactions = () => useContext(TransactionContext);

export const TransactionProvider = ({ children }) => {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadTransactions = async () => {
      try {
        const stored = await localforage.getItem('stock_transactions');
        if (stored) {
          setTransactions(stored);
        }
      } catch (err) {
        console.error('Failed to load transactions', err);
      } finally {
        setLoading(false);
      }
    };
    loadTransactions();
  }, []);

  const saveTransactions = async (newTransactions) => {
    setTransactions(newTransactions);
    await localforage.setItem('stock_transactions', newTransactions);
  };

  const addTransaction = async (tx) => {
    const newTx = {
      ...tx,
      id: Date.now().toString(),
      // Ensure numeric fields are stored as numbers
      shares: Number(tx.shares) || 0,
      price: Number(tx.price) || 0,
      fees: Number(tx.fees) || 0,
      amount: Number(tx.amount) || 0,
      exchangeRate: Number(tx.exchangeRate) || 1,
    };
    
    // Automatically calculate amount if not provided for trade types
    if (['BUY', 'SELL'].includes(tx.type) && !newTx.amount) {
      newTx.amount = newTx.shares * newTx.price;
    }
    
    const newTransactions = [...transactions, newTx];
    await saveTransactions(newTransactions);
  };

  const deleteTransaction = async (id) => {
    const newTransactions = transactions.filter(t => t.id !== id);
    await saveTransactions(newTransactions);
  };

  const updateTransaction = async (id, updatedTx) => {
    const newTransactions = transactions.map(t => (t.id === id ? { ...t, ...updatedTx } : t));
    await saveTransactions(newTransactions);
  };

  return (
    <TransactionContext.Provider value={{
      transactions,
      addTransaction,
      deleteTransaction,
      updateTransaction,
      loading
    }}>
      {children}
    </TransactionContext.Provider>
  );
};
