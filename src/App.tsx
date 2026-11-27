import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  BarChart3,
  Calendar,
  Check,
  Coins,
  Delete,
  History,
  Keyboard,
  LogIn,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  UserCircle2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {FairnessModal} from './components/FairnessModal';
import {NumberWheel} from './components/NumberWheel';
import {OwnerControlDock} from './components/OwnerControlDock';
import {OfflineIndicator, PWAInstallButton} from './components/PWAControls';
import type {
  PublicRoundState,
  RoundHistoryItem,
  SelectionEntry,
  UserPublic,
  WsRoundEvent,
} from './types/game';
import {soundEngine} from './utils/sound';

type BottomTab = 'history' | 'numbers' | 'reports' | 'customer' | 'owner';

interface QueuedEntry {
  id: string;
  selectedNumber: number;
  pointsStaked: number;
}

const BACKDROP_IMAGE = '/src/assets/images/fun_target_backdrop_1795454557808.jpg';
const QUICK_CHIPS = [10, 50, 100, 500, 1000] as const;

export default function App() {
  const [backdropFailed, setBackdropFailed] = useState(false);

  // Customer session stored in React memory (Bearer token)
  const [customerToken, setCustomerToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserPublic | null>(null);
  const [currentSelections, setCurrentSelections] = useState<SelectionEntry[]>([]);
  const [userHistory, setUserHistory] = useState<SelectionEntry[]>([]);

  // Owner session stored in React memory (Bearer token)
  const [adminToken, setAdminToken] = useState<string | null>(null);

  // Authoritative server round state
  const [round, setRound] = useState<PublicRoundState | null>(null);

  // Keyboard & Mouse Multi-Number + Multiple-Entries Selection State
  const [stagedStakes, setStagedStakes] = useState<Record<number, number>>({});
  const [queuedEntries, setQueuedEntries] = useState<QueuedEntry[]>([]);
  const [activeNumber, setActiveNumber] = useState<number | null>(null);
  const [lastTargetNumber, setLastTargetNumber] = useState<number | null>(null);
  const [pointsBuffer, setPointsBuffer] = useState<string>('100');
  const [replaceOnNextDigit, setReplaceOnNextDigit] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [lastRoundWinAmount, setLastRoundWinAmount] = useState<number>(0);

  // Single-screen lower panel tabs & side summary chart toggle
  const [activeTab, setActiveTab] = useState<BottomTab>('numbers');
  const [summaryChartView, setSummaryChartView] = useState<'auto' | 'current' | 'previous'>('auto');
  const [muted, setMuted] = useState(false);
  const [verifyRound, setVerifyRound] = useState<RoundHistoryItem | null>(null);

  // Inline Customer Profile Switcher Modal (optional sign-in/register on same screen)
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register' | null>(null);
  const [authUsername, setAuthUsername] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const customerTokenRef = useRef<string | null>(null);
  customerTokenRef.current = customerToken;
  const initGuestRef = useRef(false);

  const refreshCustomerData = useCallback(async (token: string) => {
    try {
      const res = await fetch('/api/auth/me', {
        headers: {Authorization: `Bearer ${token}`},
      });
      if (res.status === 401 || res.status === 403) {
        setCustomerToken(null);
        setUser(null);
        return;
      }
      if (res.ok) {
        const json = (await res.json()) as {
          user: UserPublic;
          currentSelections: SelectionEntry[];
          history: SelectionEntry[];
        };
        setUser(json.user);
        setCurrentSelections(json.currentSelections);
        setUserHistory(json.history);
      }
    } catch {
      // Transient fetch hiccup
    }
  }, []);

  // Auto-provision default local demo player on launch so single screen is immediately playable
  useEffect(() => {
    if (initGuestRef.current || customerToken) return;
    initGuestRef.current = true;
    void fetch('/api/auth/guest', {method: 'POST'})
      .then((res) => (res.ok ? res.json() : null))
      .then((json: {token?: string; user?: UserPublic} | null) => {
        if (json?.token && json?.user) {
          setCustomerToken(json.token);
          setUser(json.user);
        }
      })
      .catch(() => {});
  }, [customerToken]);

  // Fetch initial game state & connect WebSocket
  useEffect(() => {
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    void fetch('/api/game/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: {round?: PublicRoundState} | null) => {
        if (active && j?.round) setRound(j.round);
      })
      .catch(() => {});

    const connectWs = () => {
      if (!active) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (customerTokenRef.current) {
          ws.send(JSON.stringify({type: 'auth', token: customerTokenRef.current}));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WsRoundEvent;
          if (msg.type === 'round:state' && msg.round) {
            setRound(msg.round);
            if (msg.round.phase === 'SELECTION') {
              setLastRoundWinAmount(0);
              if (customerTokenRef.current) {
                void refreshCustomerData(customerTokenRef.current);
              }
            }
          } else if (msg.type === 'round:tick' && typeof msg.secondsRemaining === 'number') {
            setRound((prev) =>
              prev ? {...prev, secondsRemaining: msg.secondsRemaining!} : prev
            );
          } else if (msg.type === 'round:spin' && msg.round) {
            setRound(msg.round);
            setStagedStakes({});
            setQueuedEntries([]);
            setActiveNumber(null);
          } else if (msg.type === 'round:result' && msg.round) {
            setRound(msg.round);
            if (customerTokenRef.current) {
              void refreshCustomerData(customerTokenRef.current);
            }
          } else if (msg.type === 'user:balance' && typeof msg.virtualPoints === 'number') {
            setUser((prev) =>
              prev
                ? {
                    ...prev,
                    virtualPoints: msg.virtualPoints!,
                    pointsEarned: msg.pointsEarned ?? prev.pointsEarned,
                    pointsSpent: msg.pointsSpent ?? prev.pointsSpent,
                    pointsLost: msg.pointsLost ?? prev.pointsLost,
                  }
                : prev
            );
            if (typeof msg.roundPayout === 'number' && msg.roundPayout > 0) {
              setLastRoundWinAmount(msg.roundPayout);
              soundEngine.playWin();
            }
          }
        } catch {
          // Ignore invalid WS messages
        }
      };

      ws.onclose = () => {
        if (active) reconnectTimer = setTimeout(connectWs, 2000);
      };
    };

    connectWs();
    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [refreshCustomerData]);

  useEffect(() => {
    if (customerToken && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({type: 'auth', token: customerToken}));
    }
  }, [customerToken]);

  const isSelectionOpen =
    round?.phase === 'SELECTION' &&
    (round?.secondsRemaining ?? 0) > 0 &&
    Boolean(round?.engineRunning);

  // Customer confirmed virtual points per number 0-9 for active round
  const myConfirmedByNumber = useMemo(() => {
    const map: Record<number, number> = {};
    for (const sel of currentSelections) {
      if (sel.roundNumber === round?.roundNumber && sel.status === 'confirmed') {
        map[sel.selectedNumber] = (map[sel.selectedNumber] || 0) + sel.pointsStaked;
      }
    }
    return map;
  }, [currentSelections, round?.roundNumber]);

  useEffect(() => {
    setSummaryChartView('auto');
  }, [round?.roundNumber]);

  const stagedNumbers = useMemo(
    () =>
      Object.keys(stagedStakes)
        .map(Number)
        .filter((n) => (stagedStakes[n] || 0) > 0),
    [stagedStakes]
  );

  const totalStagedPoints = useMemo(() => {
    const draftTotal = stagedNumbers.reduce((acc, n) => acc + (stagedStakes[n] || 0), 0);
    const queuedTotal = queuedEntries.reduce((acc, q) => acc + q.pointsStaked, 0);
    return draftTotal + queuedTotal;
  }, [queuedEntries, stagedNumbers, stagedStakes]);

  const pendingEntryCount = stagedNumbers.length + queuedEntries.length;

  const totalRoundSelectedAll = useMemo(
    () =>
      (round?.currentNumberTotals || []).reduce((acc, item) => acc + item.totalPoints, 0),
    [round?.currentNumberTotals]
  );

  const prevStats = round?.previousRoundStats ?? null;
  const hasPrevWithPoints = Boolean(
    prevStats && prevStats.totalStaked > 0 && (round?.previousRoundNumberTotals?.length ?? 0) > 0
  );
  const showingPreviousInChart =
    hasPrevWithPoints &&
    (summaryChartView === 'previous' ||
      (summaryChartView === 'auto' &&
        round?.phase === 'SELECTION' &&
        totalRoundSelectedAll === 0 &&
        pendingEntryCount === 0));

  const chartTotals = showingPreviousInChart
    ? round?.previousRoundNumberTotals || []
    : round?.currentNumberTotals || [];

  const chartTotalConfirmedPoints = showingPreviousInChart
    ? prevStats?.totalStaked ?? 0
    : totalRoundSelectedAll;

  const chartTotalPendingPoints = showingPreviousInChart ? 0 : totalStagedPoints;
  const chartTotalPoints = chartTotalConfirmedPoints + chartTotalPendingPoints;

  const chartRoundNumber = showingPreviousInChart
    ? prevStats?.roundNumber ?? round?.roundNumber ?? 1
    : round?.roundNumber ?? 1;

  const chartWinningNumber = showingPreviousInChart
    ? prevStats?.winningNumber ?? null
    : round?.phase === 'RESULT' || round?.phase === 'PAUSED'
      ? round?.winningNumber ?? null
      : null;

  const myRoundConfirmedTotal = useMemo(
    () => Object.values(myConfirmedByNumber).reduce((acc, v) => acc + v, 0),
    [myConfirmedByNumber]
  );

  const lastWinningRewardPoints = round?.previousRoundStats?.totalAwarded ?? 0;
  const enteredPointsNum = parseInt(pointsBuffer || '0', 10) || 0;

  const handleSelectNumber = useCallback(
    (num: number) => {
      soundEngine.playChip();
      setFeedback(null);
      setLastTargetNumber(num);
      setActiveNumber(num);
      setReplaceOnNextDigit(true);

      const existingStaged = stagedStakes[num];
      if (existingStaged !== undefined) {
        setPointsBuffer(String(existingStaged));
        return;
      }

      const stake = Math.max(1, enteredPointsNum || 100);
      setStagedStakes((prev) => ({...prev, [num]: stake}));
      setPointsBuffer(String(stake));
    },
    [enteredPointsNum, stagedStakes]
  );

  const handleRemoveStagedNumber = useCallback(
    (num: number) => {
      soundEngine.playCancel();
      setStagedStakes((prev) => {
        if (prev[num] === undefined) return prev;
        const copy = {...prev};
        delete copy[num];
        const remainingKeys = Object.keys(copy).map(Number);
        setActiveNumber((prevActive) =>
          prevActive === num ? (remainingKeys.length > 0 ? remainingKeys[0] : null) : prevActive
        );
        return copy;
      });
    },
    []
  );

  const handleSelectAllNumbers = useCallback(() => {
    soundEngine.playChip();
    const stake = Math.max(1, enteredPointsNum || 100);
    const all: Record<number, number> = {};
    for (let n = 0; n <= 9; n++) {
      all[n] = stake;
    }
    setStagedStakes(all);
    setActiveNumber(null);
    setReplaceOnNextDigit(true);
    setFeedback(`Selected all 10 numbers (1–0) at ${stake.toLocaleString()} POINTS each.`);
  }, [enteredPointsNum]);

  const applyBufferValue = useCallback(
    (nextBuf: string) => {
      setPointsBuffer(nextBuf);
      const parsed = parseInt(nextBuf || '0', 10) || 0;
      if (parsed <= 0) return;
      if (activeNumber !== null) {
        setStagedStakes((prev) =>
          prev[activeNumber] !== undefined ? {...prev, [activeNumber]: parsed} : prev
        );
      } else if (stagedNumbers.length === 0 && lastTargetNumber !== null) {
        setStagedStakes({[lastTargetNumber]: parsed});
        setActiveNumber(lastTargetNumber);
      }
    },
    [activeNumber, lastTargetNumber, stagedNumbers.length]
  );

  const handleAppendDigit = useCallback(
    (digit: string) => {
      soundEngine.playChip();
      setFeedback(null);
      setPointsBuffer((prev) => {
        const next = replaceOnNextDigit || prev === '0' ? digit : (prev + digit).slice(0, 6);
        const parsed = parseInt(next || '0', 10) || 0;
        if (parsed > 0) {
          if (activeNumber !== null) {
            setStagedStakes((prevStakes) =>
              prevStakes[activeNumber] !== undefined
                ? {...prevStakes, [activeNumber]: parsed}
                : prevStakes
            );
          } else if (stagedNumbers.length === 0 && lastTargetNumber !== null) {
            setStagedStakes({[lastTargetNumber]: parsed});
            setActiveNumber(lastTargetNumber);
          }
        }
        return next;
      });
      setReplaceOnNextDigit(false);
    },
    [activeNumber, lastTargetNumber, replaceOnNextDigit, stagedNumbers.length]
  );

  const handleBackspace = useCallback(() => {
    soundEngine.playChip();
    setReplaceOnNextDigit(false);
    setPointsBuffer((prev) => {
      const next = prev.length <= 1 ? '0' : prev.slice(0, -1);
      const parsed = parseInt(next || '0', 10) || 0;
      if (activeNumber !== null && parsed > 0) {
        setStagedStakes((prevStakes) =>
          prevStakes[activeNumber] !== undefined
            ? {...prevStakes, [activeNumber]: parsed}
            : prevStakes
        );
      }
      return next;
    });
  }, [activeNumber]);

  const handleApplyToAllStaged = useCallback(() => {
    soundEngine.playChip();
    const stake = Math.max(1, enteredPointsNum || 100);
    setStagedStakes((prev) => {
      const updated: Record<number, number> = {};
      for (const key of Object.keys(prev)) {
        updated[Number(key)] = stake;
      }
      return updated;
    });
    setFeedback(`Updated all selected numbers to ${stake.toLocaleString()} POINTS each.`);
  }, [enteredPointsNum]);

  const handleQueueCurrentEntries = useCallback(() => {
    if (!isSelectionOpen) {
      setFeedback('Selections are currently locked.');
      return;
    }
    const itemsToQueue = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]
      .filter((n) => (stagedStakes[n] || 0) > 0)
      .map((n) => ({
        id: `${Date.now()}-${n}-${Math.random().toString(36).slice(2, 7)}`,
        selectedNumber: n,
        pointsStaked: stagedStakes[n],
      }));

    if (itemsToQueue.length === 0) {
      setFeedback('Select a number (1–0) and enter points to add an entry.');
      return;
    }
    soundEngine.playChip();
    setQueuedEntries((prev) => [...prev, ...itemsToQueue]);
    setLastTargetNumber(itemsToQueue[itemsToQueue.length - 1].selectedNumber);
    setStagedStakes({});
    setActiveNumber(null);
    setReplaceOnNextDigit(true);
    setFeedback(
      `Added ${itemsToQueue.map((i) => `#${i.selectedNumber}: ${i.pointsStaked}`).join(', ')} to entry queue. Add more or press Enter to confirm.`
    );
  }, [isSelectionOpen, stagedStakes]);

  const handleCancelEntry = useCallback(() => {
    soundEngine.playCancel();
    setStagedStakes({});
    setQueuedEntries([]);
    setActiveNumber(null);
    setPointsBuffer('100');
    setReplaceOnNextDigit(false);
    setFeedback('Staged and queued entries cleared.');
  }, []);

  const handleConfirmEntry = useCallback(async () => {
    if (!isSelectionOpen) {
      setFeedback('Selections are currently locked.');
      return;
    }
    const draftEntries = stagedNumbers.map((num) => ({
      selectedNumber: num,
      pointsStaked: stagedStakes[num],
    }));
    const entries = [
      ...queuedEntries.map((q) => ({
        selectedNumber: q.selectedNumber,
        pointsStaked: q.pointsStaked,
      })),
      ...draftEntries,
    ];
    if (entries.length === 0) {
      setFeedback('Select one or more numbers (1–0) first.');
      return;
    }
    if (!customerToken) {
      setFeedback('Preparing customer profile...');
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const submitWithToken = async (tok: string) =>
        fetch('/api/game/select', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tok}`,
          },
          body: JSON.stringify({entries}),
        });

      let activeTok = customerToken;
      let res = await submitWithToken(activeTok);

      if (res.status === 401) {
        const guestRes = await fetch('/api/auth/guest', {method: 'POST'});
        if (guestRes.ok) {
          const guestJson = (await guestRes.json()) as {token?: string; user?: UserPublic};
          if (guestJson.token && guestJson.user) {
            activeTok = guestJson.token;
            setCustomerToken(guestJson.token);
            setUser(guestJson.user);
            res = await submitWithToken(activeTok);
          }
        }
      }

      const json = (await res.json()) as {
        user?: UserPublic;
        currentSelections?: SelectionEntry[];
        history?: SelectionEntry[];
        round?: PublicRoundState;
        error?: string;
      };
      if (!res.ok) {
        setFeedback(json.error || 'Could not confirm entries.');
        return;
      }
      soundEngine.playConfirm();
      if (json.user) setUser(json.user);
      if (json.currentSelections) setCurrentSelections(json.currentSelections);
      if (json.history) setUserHistory(json.history);
      if (json.round) setRound(json.round);
      setFeedback(
        `Confirmed ${entries.length} entr${entries.length > 1 ? 'ies' : 'y'} (${totalStagedPoints.toLocaleString()} POINTS total).`
      );
      setStagedStakes({});
      setQueuedEntries([]);
      setActiveNumber(null);
      setReplaceOnNextDigit(true);
    } finally {
      setSubmitting(false);
    }
  }, [customerToken, isSelectionOpen, queuedEntries, stagedNumbers, stagedStakes, totalStagedPoints]);

  const handleCancelConfirmed = async () => {
    if (!customerToken || !isSelectionOpen) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/game/cancel', {
        method: 'POST',
        headers: {Authorization: `Bearer ${customerToken}`},
      });
      const json = (await res.json()) as {
        refunded?: number;
        user?: UserPublic;
        currentSelections?: SelectionEntry[];
        history?: SelectionEntry[];
        round?: PublicRoundState;
        error?: string;
      };
      if (!res.ok) {
        setFeedback(json.error || 'Cannot cancel confirmed entries.');
        return;
      }
      soundEngine.playCancel();
      if (json.user) setUser(json.user);
      if (json.currentSelections) setCurrentSelections(json.currentSelections);
      if (json.history) setUserHistory(json.history);
      if (json.round) setRound(json.round);
      setFeedback(`Refunded ${(json.refunded || 0).toLocaleString()} POINTS.`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdjustConfirmedNumber = useCallback(
    async (num: number, delta: number) => {
      if (!isSelectionOpen) {
        setFeedback('Selections are currently locked.');
        return;
      }
      if (!customerToken) {
        setFeedback('Preparing customer profile...');
        return;
      }
      setSubmitting(true);
      setFeedback(null);
      try {
        const callAdjust = async (tok: string) =>
          fetch('/api/game/adjust-number', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${tok}`,
            },
            body: JSON.stringify({selectedNumber: num, delta}),
          });

        let activeTok = customerToken;
        let res = await callAdjust(activeTok);
        if (res.status === 401) {
          const guestRes = await fetch('/api/auth/guest', {method: 'POST'});
          if (guestRes.ok) {
            const guestJson = (await guestRes.json()) as {token?: string; user?: UserPublic};
            if (guestJson.token && guestJson.user) {
              activeTok = guestJson.token;
              setCustomerToken(guestJson.token);
              setUser(guestJson.user);
              res = await callAdjust(activeTok);
            }
          }
        }

        const json = (await res.json()) as {
          adjustedBy?: number;
          user?: UserPublic;
          currentSelections?: SelectionEntry[];
          history?: SelectionEntry[];
          round?: PublicRoundState;
          error?: string;
        };
        if (!res.ok) {
          setFeedback(json.error || 'Could not adjust points.');
          return;
        }
        soundEngine.playChip();
        if (json.user) setUser(json.user);
        if (json.currentSelections) setCurrentSelections(json.currentSelections);
        if (json.history) setUserHistory(json.history);
        if (json.round) setRound(json.round);
        const by = json.adjustedBy ?? delta;
        setFeedback(
          `${by > 0 ? 'Added +' : 'Subtracted '}${by.toLocaleString()} PTS on #${num}.`
        );
      } finally {
        setSubmitting(false);
      }
    },
    [customerToken, isSelectionOpen]
  );

  const handleAdjustNumberDelta = useCallback(
    (num: number, delta: number) => {
      if (!isSelectionOpen) {
        setFeedback('Selections are currently locked.');
        return;
      }
      setFeedback(null);
      setLastTargetNumber(num);

      if (stagedStakes[num] !== undefined) {
        soundEngine.playChip();
        const nextVal = Math.min(100000, stagedStakes[num] + delta);
        if (nextVal <= 0) {
          handleRemoveStagedNumber(num);
          setPointsBuffer('100');
        } else {
          setStagedStakes((prev) => ({...prev, [num]: nextVal}));
          setActiveNumber(num);
          setPointsBuffer(String(nextVal));
          setReplaceOnNextDigit(true);
        }
        return;
      }

      if ((myConfirmedByNumber[num] || 0) > 0) {
        void handleAdjustConfirmedNumber(num, delta);
        return;
      }

      if (delta > 0) {
        soundEngine.playChip();
        setStagedStakes((prev) => ({...prev, [num]: delta}));
        setActiveNumber(num);
        setPointsBuffer(String(delta));
        setReplaceOnNextDigit(true);
      }
    },
    [
      handleAdjustConfirmedNumber,
      handleRemoveStagedNumber,
      isSelectionOpen,
      myConfirmedByNumber,
      stagedStakes,
    ]
  );

  // Full Computer Keyboard Support (Section 2 & 6)
  // - Number keys 0–9 (Digit0..Digit9): Select or return to number 0–9
  // - Numeric keypad (Numpad0..Numpad9): Enter virtual points
  // - ArrowUp / '=': +50 PTS, ArrowDown / '-' / NumpadSubtract: -50 PTS
  // - + / NumpadAdd: Add multiple point entry to queue for same/different numbers
  // - Enter / NumpadEnter: Confirm entry
  // - Backspace: Edit points
  // - Escape: Cancel entry
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      ) {
        return;
      }

      if (e.code.startsWith('Digit')) {
        const digit = Number(e.code.replace('Digit', ''));
        if (digit >= 0 && digit <= 9) {
          e.preventDefault();
          handleSelectNumber(digit);
        }
        return;
      }

      if (e.code.startsWith('Numpad') && e.code.length === 7) {
        const digit = e.code.replace('Numpad', '');
        if (/^[0-9]$/.test(digit)) {
          e.preventDefault();
          handleAppendDigit(digit);
        }
        return;
      }

      if (e.key === '+' || e.code === 'NumpadAdd') {
        e.preventDefault();
        handleQueueCurrentEntries();
        return;
      }

      if (e.key === '=' || e.key === 'ArrowUp') {
        const targetNum = activeNumber ?? lastTargetNumber;
        if (targetNum !== null) {
          e.preventDefault();
          handleAdjustNumberDelta(targetNum, 50);
        }
        return;
      }

      if (e.key === '-' || e.code === 'NumpadSubtract' || e.key === 'ArrowDown') {
        const targetNum = activeNumber ?? lastTargetNumber;
        if (targetNum !== null) {
          e.preventDefault();
          handleAdjustNumberDelta(targetNum, -50);
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        void handleConfirmEntry();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (verifyRound) setVerifyRound(null);
        else if (authModalMode) setAuthModalMode(null);
        else handleCancelEntry();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeNumber,
    authModalMode,
    handleAdjustNumberDelta,
    handleAppendDigit,
    handleBackspace,
    handleCancelEntry,
    handleConfirmEntry,
    handleQueueCurrentEntries,
    handleSelectNumber,
    lastTargetNumber,
    verifyRound,
  ]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authModalMode) return;
    setAuthError('');
    setAuthSubmitting(true);
    try {
      const endpoint = authModalMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body =
        authModalMode === 'register'
          ? {username: authUsername, email: authEmail, password: authPassword}
          : {identifier: authUsername, password: authPassword};
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {token?: string; user?: UserPublic; error?: string};
      if (!res.ok || !json.token || !json.user) {
        setAuthError(json.error || 'Authentication failed.');
        return;
      }
      setCustomerToken(json.token);
      setUser(json.user);
      setAuthModalMode(null);
      setAuthPassword('');
      await refreshCustomerData(json.token);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    soundEngine.setMuted(next);
  };

  const secondsDisplay = String(round?.secondsRemaining ?? 120).padStart(2, '0');
  const winningDisplay =
    round?.phase === 'RESULT' && round.winningNumber !== null
      ? String(round.winningNumber)
      : round?.phase === 'SPINNING'
        ? '•••'
        : round?.last10Results?.[0]
          ? String(round.last10Results[0].winningNumber)
          : '--';

  return (
    <div className="relative min-h-screen w-full bg-[#070504] text-[#F5EFE6] flex flex-col">
      {/* Subtle Mahogany & Obsidian Table Texture */}
      {!backdropFailed && (
        <img
          src={BACKDROP_IMAGE}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          onError={() => setBackdropFailed(true)}
          className="pointer-events-none fixed inset-0 h-full w-full object-cover opacity-20"
        />
      )}

      {/* 2. TOP INFORMATION PANEL */}
      <header className="relative z-20 border-b border-amber-500/30 bg-[#100B08]/95 px-4 py-3">
        <div className="mx-auto max-w-7xl space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Brand + Mode Subtitle */}
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full border-2 border-amber-400 bg-[#6E0E0E] flex items-center justify-center font-bold text-amber-200 text-sm shrink-0">
                FT
              </div>
              <div>
                <h1
                  className="text-lg sm:text-xl font-extrabold tracking-wider text-amber-300 leading-none"
                  style={{fontFamily: 'var(--font-display)'}}
                >
                  FUN TARGET
                </h1>
                <p className="text-[11px] text-stone-400 mt-0.5">
                  0–9 Number Wheel · Virtual Points Simulation ·{' '}
                  {round?.ruleMode === 'demo_lowest_points'
                    ? '1,500-Point Pool / Lowest Rule'
                    : round?.ruleMode === 'demo_two_round'
                      ? 'Demo Two-Round Rule'
                      : 'Fair Verifiable RNG'}
                </p>
              </div>
            </div>

            {/* Key Top Telemetry: Round #, 60s Timer, Total Virtual Points, Winning Number */}
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-4">
              <div className="rounded-lg border border-amber-500/25 bg-[#18110C] px-3 py-1.5">
                <span className="block text-[10px] text-stone-400">ROUND</span>
                <span className="font-mono text-sm font-bold tabular-nums text-amber-200">
                  #{round?.roundNumber ?? 1}
                </span>
              </div>

              <div className="rounded-lg border border-amber-500/35 bg-[#18110C] px-3.5 py-1.5 text-center">
                <span className="block text-[10px] text-stone-400">TIMER (120s)</span>
                <span
                  className={`font-mono text-base font-bold tabular-nums ${
                    round?.phase === 'SELECTION' && (round?.secondsRemaining ?? 120) <= 10
                      ? 'text-red-400'
                      : 'text-amber-300'
                  }`}
                >
                  {round?.phase === 'PAUSED' ? 'PAUSED' : `${secondsDisplay}s`}
                </span>
              </div>

              <div className="rounded-lg border border-amber-500/25 bg-[#18110C] px-3 py-1.5">
                <span className="block text-[10px] text-stone-400">TOTAL VIRTUAL POINTS</span>
                <span className="font-mono text-sm font-bold tabular-nums text-amber-300">
                  {(user?.virtualPoints ?? 0).toLocaleString()} POINTS
                </span>
              </div>

              <div className="rounded-lg border border-amber-400/50 bg-gradient-to-b from-[#3A220D] to-[#1A1008] px-3.5 py-1.5 text-center">
                <span className="block text-[10px] text-amber-200/80">WINNING NO.</span>
                <span
                  className="font-mono text-base font-extrabold tabular-nums text-amber-200"
                  style={{fontFamily: 'var(--font-display)'}}
                >
                  {winningDisplay}
                </span>
              </div>
            </div>

            {/* Utility Controls: Mute, Profile Switcher, PWA Install */}
            <div className="flex items-center gap-2 shrink-0">
              <PWAInstallButton />
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? 'Unmute sound' : 'Mute sound'}
                className="p-2 rounded-lg border border-amber-500/25 bg-[#18110C] text-amber-200 hover:bg-amber-500/15 cursor-pointer"
              >
                {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthError('');
                  setAuthModalMode('login');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-500/35 bg-[#18110C] text-xs font-semibold text-amber-200 hover:bg-amber-500/15 cursor-pointer whitespace-nowrap"
              >
                <UserCircle2 className="w-4 h-4 text-amber-400" />
                <span>{user?.username || 'Player'}</span>
              </button>
            </div>
          </div>

          {/* Last 10 Results Strip inside Top Information Panel */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-500/15">
            <span className="text-[11px] font-semibold tracking-wider text-stone-400">
              LAST 10 RESULTS
            </span>
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {(round?.last10Results || []).slice(0, 10).map((item, idx) => (
                <div
                  key={item.roundNumber}
                  title={`Round #${item.roundNumber} — Winner ${item.winningNumber}`}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-sm font-bold tabular-nums border shrink-0 ${
                    idx === 0
                      ? 'bg-gradient-to-b from-amber-300 to-amber-500 text-stone-950 border-amber-100 shadow-md'
                      : item.winningNumber % 2 === 0
                        ? 'bg-[#6E0E0E]/85 text-amber-200 border-amber-500/35'
                        : 'bg-[#1D1510] text-amber-200 border-amber-500/25'
                  }`}
                >
                  {item.winningNumber}
                </div>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* MAIN SINGLE-SCREEN WORKSPACE */}
      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-4 py-5 space-y-5">
        {/* 3. CIRCULAR NUMBER WHEEL & LIVE POINTS SUMMARY CHART BESIDE WHEEL */}
        <section className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6 lg:gap-8">
          <div className="flex flex-col items-center justify-center shrink-0">
            <NumberWheel
              roundNumber={round?.roundNumber ?? 1}
              phase={round?.phase ?? 'SELECTION'}
              secondsRemaining={round?.secondsRemaining ?? 120}
              winningNumber={round?.winningNumber ?? null}
              showWinCoins={lastRoundWinAmount > 0 && round?.phase === 'RESULT'}
            />

            {round?.phase === 'RESULT' && round.winningNumber !== null && (
              <div className="mt-3 rounded-xl border border-amber-400/50 bg-[#1B120B] px-6 py-2 text-center shadow-lg">
                <span className="text-sm font-bold text-amber-200">
                  Round #{round.roundNumber} Winning Number: #{round.winningNumber}
                  {lastRoundWinAmount > 0
                    ? ` · +${lastRoundWinAmount.toLocaleString()} POINTS Earned`
                    : ''}
                </span>
              </div>
            )}
          </div>

          {/* Summary Chart Beside Wheel (stays visible through round end and into the 60s cycle until new points are placed) */}
          <aside
            aria-label="Points placed on each number"
            className="w-full max-w-sm sm:w-[290px] md:w-[330px] lg:w-[350px] shrink-0 rounded-2xl border border-amber-500/35 bg-[#120D09]/95 p-3.5 sm:p-4 shadow-[0_12px_36px_rgba(0,0,0,0.65)] flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-2 border-b border-amber-500/20 pb-2.5 mb-3">
                <div>
                  <h2 className="text-xs font-bold tracking-wider text-amber-300">
                    POINTS SUMMARY (1–0)
                  </h2>
                  <p className="text-[11px] text-stone-400">
                    {showingPreviousInChart
                      ? `Round #${chartRoundNumber} · Next Round #${round?.roundNumber ?? 1} (${secondsDisplay}s)`
                      : `Round #${chartRoundNumber}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {hasPrevWithPoints && (
                    <button
                      type="button"
                      onClick={() =>
                        setSummaryChartView(showingPreviousInChart ? 'current' : 'previous')
                      }
                      className="font-mono text-[10px] font-semibold px-2 py-0.5 rounded border border-amber-500/30 bg-[#1B120B] text-amber-200 hover:border-amber-400 cursor-pointer"
                    >
                      {showingPreviousInChart
                        ? `Live #${round?.roundNumber ?? 1}`
                        : `Prev #${prevStats?.roundNumber}`}
                    </button>
                  )}
                  <span
                    className={`font-mono text-[11px] font-bold px-2 py-0.5 rounded border ${
                      chartWinningNumber !== null
                        ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
                        : round?.phase === 'SPINNING'
                          ? 'border-rose-400/50 bg-rose-950/50 text-rose-200'
                          : round?.phase === 'PAUSED'
                            ? 'border-stone-600 bg-stone-900 text-stone-300'
                            : 'border-emerald-500/45 bg-emerald-950/40 text-emerald-300'
                    }`}
                  >
                    {chartWinningNumber !== null
                      ? `WINNER #${chartWinningNumber}`
                      : round?.phase === 'SPINNING'
                        ? 'SPINNING'
                        : round?.phase === 'PAUSED'
                          ? 'PAUSED'
                          : 'OPEN'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {([1, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const).map((num) => {
                  const cell = chartTotals.find((c) => c.number === num);
                  const confirmedPts = cell?.totalPoints ?? 0;
                  const confirmedCount = cell?.selectionCount ?? 0;
                  const stagedForNum = showingPreviousInChart ? 0 : stagedStakes[num] || 0;
                  const queuedForNum = showingPreviousInChart
                    ? []
                    : queuedEntries.filter((q) => q.selectedNumber === num);
                  const pendingPts =
                    stagedForNum + queuedForNum.reduce((s, q) => s + q.pointsStaked, 0);
                  const pendingCnt = (stagedForNum > 0 ? 1 : 0) + queuedForNum.length;
                  const pts = confirmedPts + pendingPts;
                  const count = confirmedCount + pendingCnt;
                  const isWin = chartWinningNumber === num;

                  return (
                    <div
                      key={num}
                      className={`flex items-center justify-between rounded-lg border px-2.5 py-2 ${
                        isWin
                          ? 'border-amber-300 bg-gradient-to-r from-amber-500/30 to-amber-900/40 shadow-[0_0_16px_rgba(245,184,46,0.4)]'
                          : pendingPts > 0
                            ? 'border-amber-400/70 bg-amber-500/15'
                            : cell?.tier === 'high'
                              ? 'border-rose-500/45 bg-rose-950/30'
                              : cell?.tier === 'low'
                                ? 'border-emerald-500/45 bg-emerald-950/25'
                                : cell?.tier === 'medium'
                                  ? 'border-amber-500/35 bg-amber-950/25'
                                  : 'border-cyan-500/25 bg-[#0A1014]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-6 h-6 rounded-md flex items-center justify-center font-mono text-sm font-extrabold border ${
                            isWin
                              ? 'bg-amber-400 text-stone-950 border-amber-200'
                              : pendingPts > 0
                                ? 'bg-amber-500/30 text-amber-200 border-amber-300'
                                : 'bg-[#1B120B] text-amber-200 border-amber-500/35'
                          }`}
                        >
                          {num}
                        </span>
                        <span className="font-mono text-[10px] text-stone-400">{count}x</span>
                      </div>
                      <div className="text-right">
                        <span
                          className={`block font-mono text-xs font-bold tabular-nums ${
                            isWin || pendingPts > 0
                              ? 'text-amber-200'
                              : pts > 0
                                ? 'text-stone-100'
                                : 'text-cyan-300/75'
                          }`}
                        >
                          {pts.toLocaleString()} PTS
                        </span>
                        {pendingPts > 0 && confirmedPts > 0 && (
                          <span className="block font-mono text-[9px] text-amber-300/80 tabular-nums">
                            +{pendingPts.toLocaleString()} pending
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Bottom Total Points Placed */}
            <div className="mt-3 pt-3 border-t border-amber-500/25 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold tracking-wider text-stone-300">
                  TOTAL POINTS PLACED
                </span>
                <span className="font-mono text-base font-extrabold tabular-nums text-amber-300">
                  {chartTotalPoints.toLocaleString()} PTS
                </span>
              </div>
              {chartTotalPendingPoints > 0 && (
                <div className="flex items-center justify-between text-[10px] font-mono text-amber-300/85">
                  <span>Pending confirmation: {chartTotalPendingPoints.toLocaleString()} PTS</span>
                  <span>Press Enter / CONFIRM</span>
                </div>
              )}
              {feedback && (
                <p className="text-[11px] font-medium text-amber-300 pt-0.5">{feedback}</p>
              )}
            </div>
          </aside>
        </section>

        {/* 5. NUMBER SELECTION BANNER DIRECTLY BELOW THE WHEEL (1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 0) */}
        <section className="rounded-2xl border border-amber-500/35 bg-[#120D09]/95 p-3 sm:p-4 shadow-[0_12px_36px_rgba(0,0,0,0.65)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-xs font-semibold tracking-wider text-amber-300">
                NUMBER SELECTION BANNER (1 – 0)
              </span>
              <button
                type="button"
                disabled={!isSelectionOpen}
                onClick={handleSelectAllNumbers}
                className="px-3 py-1 rounded-lg border border-amber-400/60 bg-amber-500/20 text-amber-200 text-xs font-bold hover:bg-amber-500/30 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                Select All (1–0)
              </button>
              {pendingEntryCount > 0 && (
                <button
                  type="button"
                  onClick={handleCancelEntry}
                  className="px-2.5 py-1 rounded-lg border border-red-500/40 bg-red-950/35 text-red-200 text-xs font-medium hover:bg-red-900/40 cursor-pointer whitespace-nowrap"
                >
                  Clear ({pendingEntryCount})
                </button>
              )}
            </div>
            <span className="text-xs text-stone-400">
              Total Points Selected This Round:{' '}
              <span className="font-mono font-bold text-amber-200 tabular-nums">
                {totalRoundSelectedAll.toLocaleString()} POINTS
              </span>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-10 gap-2 sm:gap-2.5">
            {([1, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const).map((num) => {
              const cell = (round?.currentNumberTotals || []).find((c) => c.number === num) || {
                number: num,
                totalPoints: 0,
                selectionCount: 0,
                entries: [],
                tier: 'unselected' as const,
              };
              const stagedPts = stagedStakes[num] || 0;
              const queuedForNum = queuedEntries.filter((q) => q.selectedNumber === num);
              const queuedSum = queuedForNum.reduce((s, q) => s + q.pointsStaked, 0);
              const isSelected = stagedPts > 0 || queuedForNum.length > 0;
              const isFocused = activeNumber === num;
              const isWinner = round?.phase === 'RESULT' && round.winningNumber === num;
              const myPts = myConfirmedByNumber[num] || 0;
              const hasAny = cell.totalPoints > 0 || myPts > 0 || stagedPts > 0 || queuedSum > 0;

              const tierCardStyle =
                cell.tier === 'high'
                  ? 'border-rose-500/60 bg-gradient-to-b from-rose-950/65 to-[#1E080A] hover:border-rose-400'
                  : cell.tier === 'low'
                    ? 'border-emerald-500/60 bg-gradient-to-b from-emerald-950/65 to-[#081C14] hover:border-emerald-400'
                    : cell.tier === 'medium'
                      ? 'border-amber-500/50 bg-gradient-to-b from-[#45280D] to-[#1A0F08] hover:border-amber-400'
                      : 'border-cyan-500/45 bg-gradient-to-b from-cyan-950/45 to-[#0A131A] hover:border-cyan-300';

              const tierBadgeText =
                cell.tier === 'high'
                  ? 'HIGH'
                  : cell.tier === 'low'
                    ? 'LOW'
                    : cell.tier === 'medium'
                      ? 'MID'
                      : 'ZERO';

              const tierBadgeColor =
                cell.tier === 'high'
                  ? 'text-rose-300'
                  : cell.tier === 'low'
                    ? 'text-emerald-300'
                    : cell.tier === 'medium'
                      ? 'text-amber-300'
                      : 'text-cyan-300';

              return (
                <div
                  key={num}
                  className={`relative rounded-xl border p-2 flex flex-col justify-between transition-transform ${
                    isWinner
                      ? 'border-amber-200 bg-gradient-to-b from-amber-400/40 to-amber-900/70 shadow-[0_0_24px_rgba(245,184,46,0.6)]'
                      : isSelected
                        ? `border-amber-300 bg-gradient-to-b from-amber-500/30 to-[#2B190B] ${
                            isFocused
                              ? 'ring-2 ring-amber-300 shadow-[0_0_20px_rgba(245,184,46,0.5)]'
                              : 'shadow-[0_0_14px_rgba(245,184,46,0.3)]'
                          }`
                        : tierCardStyle
                  }`}
                >
                  {stagedPts > 0 && isSelectionOpen && (
                    <button
                      type="button"
                      onClick={() => handleRemoveStagedNumber(num)}
                      title={`Remove #${num} from staged selection`}
                      aria-label={`Remove number ${num}`}
                      className="absolute -top-1.5 -right-1.5 z-10 w-5 h-5 rounded-full border border-red-400/70 bg-[#4A0B0B] text-red-100 text-[10px] font-bold flex items-center justify-center hover:bg-red-700 cursor-pointer"
                    >
                      ×
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={!isSelectionOpen}
                    onClick={() => handleSelectNumber(num)}
                    className="w-full flex flex-col items-center disabled:opacity-65 cursor-pointer"
                  >
                    <div className="w-full flex items-center justify-between text-[10px]">
                      <span className="font-mono text-stone-300">
                        {cell.selectionCount}x
                      </span>
                      <span
                        className={`font-bold ${
                          isFocused
                            ? 'text-amber-100'
                            : isSelected
                              ? 'text-amber-200'
                              : tierBadgeColor
                        }`}
                      >
                        {isFocused ? 'EDITING' : isSelected ? 'STAGED' : tierBadgeText}
                      </span>
                    </div>

                    <span
                      className="my-0.5 text-2xl sm:text-3xl font-extrabold text-amber-200"
                      style={{fontFamily: 'var(--font-display)'}}
                    >
                      {num}
                    </span>

                    {/* Individual Point Entries List */}
                    <div className="w-full min-h-[20px] flex flex-wrap items-center justify-center gap-1 my-1">
                      {cell.entries.length > 0 ? (
                        <>
                          {cell.entries.slice(-4).map((entry) => (
                            <span
                              key={entry.id}
                              title={`${entry.username}: ${entry.pointsStaked.toLocaleString()} PTS`}
                              className="px-1 py-0.5 rounded bg-black/50 border border-amber-500/25 font-mono text-[9px] text-amber-100 tabular-nums"
                            >
                              {entry.pointsStaked}
                            </span>
                          ))}
                          {cell.entries.length > 4 && (
                            <span className="text-[9px] text-stone-400">
                              +{cell.entries.length - 4}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-[9px] text-cyan-300/75 font-mono">No picks</span>
                      )}
                    </div>

                    <div className="w-full border-t border-white/10 pt-1 text-center font-mono text-[10px] tabular-nums">
                      <span className={hasAny ? 'text-amber-200 font-bold' : 'text-cyan-300/80'}>
                        {cell.totalPoints.toLocaleString()} PTS
                      </span>
                      {(stagedPts > 0 || queuedSum > 0) && (
                        <span className="block text-amber-300 font-bold">
                          +{(stagedPts + queuedSum).toLocaleString()}
                        </span>
                      )}
                      {myPts > 0 && (
                        <span className="block text-emerald-300">You: {myPts.toLocaleString()}</span>
                      )}
                    </div>
                  </button>

                  {/* Quick +/- Adjust Buttons on Card */}
                  {isSelectionOpen && (stagedPts > 0 || myPts > 0) && (
                    <div className="mt-1.5 pt-1 border-t border-white/10 flex items-center justify-between gap-1">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => handleAdjustNumberDelta(num, -50)}
                        title={`Subtract 50 PTS from #${num}`}
                        className="flex-1 py-0.5 rounded border border-red-500/45 bg-red-950/45 text-red-200 font-mono text-[10px] font-bold hover:bg-red-900/60 cursor-pointer disabled:opacity-50"
                      >
                        -50
                      </button>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => handleAdjustNumberDelta(num, 50)}
                        title={`Add 50 PTS to #${num}`}
                        className="flex-1 py-0.5 rounded border border-emerald-500/45 bg-emerald-950/45 text-emerald-200 font-mono text-[10px] font-bold hover:bg-emerald-900/60 cursor-pointer disabled:opacity-50"
                      >
                        +50
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 4. Low, High & Zero Points Color Statistics Bar */}
          {round && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-500/15 text-[11px]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-cyan-300 font-medium">
                  <span className="w-2.5 h-2.5 rounded-sm bg-cyan-400 inline-block" />
                  Zero Points / No Picks ({round.zeroSelectionNumbers.length}):{' '}
                  <strong className="font-mono">
                    {round.zeroSelectionNumbers.length > 0
                      ? round.zeroSelectionNumbers.join(', ')
                      : 'None'}
                  </strong>
                </span>
                <span className="inline-flex items-center gap-1.5 text-emerald-300 font-medium">
                  <span className="w-2.5 h-2.5 rounded-sm bg-emerald-400 inline-block" />
                  Low Points ({round.lowPointNumbers.length}):{' '}
                  <strong className="font-mono">
                    {round.lowPointNumbers.length > 0 ? round.lowPointNumbers.join(', ') : 'None'}
                  </strong>
                </span>
                <span className="inline-flex items-center gap-1.5 text-rose-300 font-medium">
                  <span className="w-2.5 h-2.5 rounded-sm bg-rose-400 inline-block" />
                  High Points ({round.highPointNumbers.length}):{' '}
                  <strong className="font-mono">
                    {round.highPointNumbers.length > 0 ? round.highPointNumbers.join(', ') : 'None'}
                  </strong>
                </span>
              </div>
              {round.ruleMode === 'demo_lowest_points' && (() => {
                const activeCells = round.currentNumberTotals.filter((c) => c.totalPoints > 0);
                const minActivePts =
                  activeCells.length > 0
                    ? Math.min(...activeCells.map((c) => c.totalPoints))
                    : 0;
                const lowestPool = activeCells
                  .filter((c) => c.totalPoints === minActivePts)
                  .map((c) => c.number);
                const roundTotal = activeCells.reduce((acc, c) => acc + c.totalPoints, 0);
                const poolTarget = round.poolTargetPoints || 1500;
                const combinedPool = (round.accumulatedPoolPoints || 0) + roundTotal;
                const poolReached = combinedPool >= poolTarget && lowestPool.length > 0;

                return (
                  <span className="text-stone-400 font-mono">
                    Target Pool ({combinedPool.toLocaleString()} / {poolTarget.toLocaleString()} PTS):{' '}
                    <strong className="text-amber-300">
                      {roundTotal === 0
                        ? `#0–#9 (Empty)`
                        : poolReached
                          ? `#${lowestPool.join(', #')} (Lowest PTS: ${minActivePts.toLocaleString()} · 1,500 Reached)`
                          : round.zeroSelectionNumbers.length > 0
                            ? `#${round.zeroSelectionNumbers.join(', #')} (Empty · ${(poolTarget - combinedPool).toLocaleString()} PTS to 1,500)`
                            : `#${lowestPool.join(', #')} (Lowest PTS: ${minActivePts.toLocaleString()})`}
                    </strong>
                  </span>
                );
              })()}
            </div>
          )}
        </section>

        {/* 6 & 7 & 9. KEYBOARD CONTROL, CUSTOMER ENTRY & POINTS SUMMARY */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Entry & Keyboard Console */}
          <div className="lg:col-span-7 rounded-xl border border-amber-500/25 bg-[#120D09]/95 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/15 pb-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                <Keyboard className="w-4 h-4" />
                <span>KEYBOARD & MULTIPLE POINT ENTRY</span>
              </div>
              <span className="text-[11px] font-mono text-stone-400">
                0–9 Number · Numpad Pts · + Queue Multi · Enter Confirm · Esc Clear
              </span>
            </div>

            {/* Active Selected Numbers + Entered Points Readout */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 items-center">
              <div className="rounded-lg border border-amber-500/30 bg-[#0A0705] p-2.5">
                <span className="block text-[10px] text-stone-400">
                  SELECTED ({stagedNumbers.length}/10)
                </span>
                <span className="font-mono text-sm font-bold text-amber-300 block truncate">
                  {stagedNumbers.length > 0
                    ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]
                        .filter((n) => stagedStakes[n] > 0)
                        .join(', ')
                    : lastTargetNumber !== null
                      ? `#${lastTargetNumber} ready`
                      : 'None'}
                </span>
              </div>

              <div className="rounded-lg border border-amber-500/30 bg-[#0A0705] p-2.5">
                <span className="block text-[10px] text-stone-400">
                  {activeNumber !== null ? `POINTS (#${activeNumber})` : 'POINTS ENTRY'}
                </span>
                <span className="font-mono text-base font-bold tabular-nums text-stone-100">
                  {enteredPointsNum.toLocaleString()} <span className="text-xs text-amber-300">PTS</span>
                </span>
                {pendingEntryCount > 0 && (
                  <span className="block font-mono text-[10px] text-amber-300/80 tabular-nums">
                    Total: {totalStagedPoints.toLocaleString()} PTS
                  </span>
                )}
              </div>

              <button
                type="button"
                disabled={!isSelectionOpen || stagedNumbers.length === 0}
                onClick={handleQueueCurrentEntries}
                title="Queue this point amount and add another amount on the same or another number (+)"
                className="min-h-[54px] rounded-xl border border-amber-400/50 bg-[#25180B] text-amber-200 font-bold text-xs tracking-wide hover:bg-amber-500/20 active:scale-95 disabled:opacity-45 cursor-pointer flex items-center justify-center gap-1 px-2"
              >
                + ADD ENTRY (+)
              </button>

              <button
                type="button"
                disabled={submitting || !isSelectionOpen || pendingEntryCount === 0}
                onClick={() => void handleConfirmEntry()}
                className="min-h-[54px] rounded-xl bg-gradient-to-b from-[#FFE082] via-[#F5B82E] to-[#B7791F] text-stone-950 font-extrabold text-xs tracking-wide shadow-[0_6px_20px_rgba(245,184,46,0.3)] hover:brightness-105 active:scale-95 disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5 px-2"
              >
                <Check className="w-4 h-4 stroke-[2.5]" />
                CONFIRM ({pendingEntryCount})
              </button>

              <button
                type="button"
                onClick={handleCancelEntry}
                className="min-h-[54px] rounded-xl border border-red-500/50 bg-gradient-to-b from-[#8F1414] to-[#570A0A] text-white font-bold text-xs tracking-wide hover:brightness-110 active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 px-2"
              >
                <X className="w-4 h-4" />
                CANCEL (Esc)
              </button>
            </div>

            {/* Queued Multi-Entry Chips */}
            {queuedEntries.length > 0 && (
              <div className="rounded-lg border border-amber-500/25 bg-[#0A0705] p-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-stone-400 font-semibold mr-1">Queued Entries:</span>
                {queuedEntries.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      setQueuedEntries((prev) => prev.filter((q) => q.id !== item.id))
                    }
                    title="Click to remove queued entry"
                    className="px-2 py-0.5 rounded border border-amber-400/40 bg-amber-500/15 font-mono text-amber-200 hover:bg-red-950/60 hover:border-red-400 cursor-pointer"
                  >
                    #{item.selectedNumber}: {item.pointsStaked.toLocaleString()} ×
                  </button>
                ))}
              </div>
            )}

            {/* Quick Chips + On-Screen Numeric Keypad for Mouse/Touch + Backspace + Cancel Confirmed */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {QUICK_CHIPS.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => {
                    soundEngine.playChip();
                    setReplaceOnNextDigit(true);
                    applyBufferValue(String(amt));
                  }}
                  className={`px-3 py-1.5 rounded-lg font-mono text-xs font-bold border cursor-pointer ${
                    pointsBuffer === String(amt)
                      ? 'bg-amber-500 text-stone-950 border-amber-300'
                      : 'bg-[#0B0806] text-amber-200 border-amber-500/25 hover:border-amber-400'
                  }`}
                >
                  {amt} PTS
                </button>
              ))}

              {stagedNumbers.length > 1 && (
                <button
                  type="button"
                  onClick={handleApplyToAllStaged}
                  className="px-3 py-1.5 rounded-lg border border-amber-400/50 bg-amber-500/15 text-amber-200 text-xs font-semibold hover:bg-amber-500/25 cursor-pointer"
                >
                  Apply {enteredPointsNum} to All ({stagedNumbers.length})
                </button>
              )}

              <button
                type="button"
                onClick={handleBackspace}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-500/25 bg-[#0B0806] text-stone-200 text-xs hover:border-amber-400 cursor-pointer"
              >
                <Delete className="w-3.5 h-3.5" />
                Edit (Backspace)
              </button>

              {myRoundConfirmedTotal > 0 && isSelectionOpen && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleCancelConfirmed()}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-950/35 text-red-200 text-xs hover:bg-red-900/40 cursor-pointer ml-auto"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Refund Confirmed ({myRoundConfirmedTotal.toLocaleString()} PTS)
                </button>
              )}
            </div>

            {/* Plus / Minus Direct Point Adjustment Bar */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[11px] text-stone-400 mr-1">
                {activeNumber !== null
                  ? `Adjust #${activeNumber}:`
                  : lastTargetNumber !== null
                    ? `Adjust #${lastTargetNumber}:`
                    : 'Adjust:'}
              </span>
              {[-100, -50, -10].map((delta) => {
                const targetNum = activeNumber ?? lastTargetNumber;
                return (
                  <button
                    key={delta}
                    type="button"
                    disabled={submitting || !isSelectionOpen || targetNum === null}
                    onClick={() => targetNum !== null && handleAdjustNumberDelta(targetNum, delta)}
                    className="px-2.5 py-1 rounded-md border border-red-500/40 bg-red-950/35 font-mono text-xs font-bold text-red-200 hover:bg-red-900/50 disabled:opacity-40 cursor-pointer"
                  >
                    {delta}
                  </button>
                );
              })}
              {[10, 50, 100].map((delta) => {
                const targetNum = activeNumber ?? lastTargetNumber;
                return (
                  <button
                    key={delta}
                    type="button"
                    disabled={submitting || !isSelectionOpen || targetNum === null}
                    onClick={() => targetNum !== null && handleAdjustNumberDelta(targetNum, delta)}
                    className="px-2.5 py-1 rounded-md border border-emerald-500/40 bg-emerald-950/35 font-mono text-xs font-bold text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-40 cursor-pointer"
                  >
                    +{delta}
                  </button>
                );
              })}
            </div>

            {/* Compact On-Screen Digit Pad for Laptops / Touchscreens */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-stone-400 mr-1">Keypad:</span>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => handleAppendDigit(d)}
                  className="w-8 h-8 rounded-md border border-amber-500/20 bg-[#0B0806] font-mono text-xs font-bold text-amber-200 hover:border-amber-400 cursor-pointer"
                >
                  {d}
                </button>
              ))}
            </div>

            {feedback && (
              <p className="text-xs font-medium text-amber-300">{feedback}</p>
            )}
          </div>

          {/* 9. Points Management Summary Panel */}
          <div className="lg:col-span-5 rounded-xl border border-amber-500/25 bg-[#120D09]/95 p-4 flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between border-b border-amber-500/15 pb-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                <Coins className="w-4 h-4" />
                <span>POINTS SUMMARY ({user?.id || 'Guest'})</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAuthError('');
                  setAuthModalMode('login');
                }}
                className="inline-flex items-center gap-1 text-xs text-amber-300 hover:underline cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" />
                Switch / Register Profile
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
              <div className="rounded-lg border border-amber-500/15 bg-[#0A0705] p-2.5">
                <span className="text-stone-400 block text-[10px]">CUSTOMER POINTS</span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-amber-300">
                  {(user?.virtualPoints ?? 0).toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-amber-500/15 bg-[#0A0705] p-2.5">
                <span className="text-stone-400 block text-[10px]">TOTAL SELECTED</span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-stone-100">
                  {totalRoundSelectedAll.toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-amber-500/15 bg-[#0A0705] p-2.5">
                <span className="text-stone-400 block text-[10px]">WINNING REWARD</span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-emerald-400">
                  {lastWinningRewardPoints.toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-amber-500/15 bg-[#0A0705] p-2.5">
                <span className="text-stone-400 block text-[10px]">POINTS EARNED</span>
                <span className="mt-0.5 block font-mono text-sm font-bold tabular-nums text-emerald-400">
                  +{(user?.pointsEarned ?? 0).toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-amber-500/15 bg-[#0A0705] p-2.5">
                <span className="text-stone-400 block text-[10px]">POINTS USED</span>
                <span className="mt-0.5 block font-mono text-sm font-bold tabular-nums text-stone-200">
                  {(user?.pointsSpent ?? 0).toLocaleString()}
                </span>
              </div>
              <div className="rounded-lg border border-amber-500/15 bg-[#0A0705] p-2.5">
                <span className="text-stone-400 block text-[10px]">THIS ROUND (YOU)</span>
                <span className="mt-0.5 block font-mono text-sm font-bold tabular-nums text-amber-200">
                  {myRoundConfirmedTotal.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* 8, 10, 11, 12, 13. SAME-SCREEN DATA, STATISTICS, REPORTS & OWNER CONTROLS */}
        <section className="rounded-xl border border-amber-500/25 bg-[#120D09]/95 p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-amber-500/15 pb-3">
            {(
              [
                ['history', 'Result History (Last 10)', History],
                ['numbers', 'Number Statistics (0–9)', BarChart3],
                ['reports', 'Daily & Weekly Reports', Calendar],
                ['customer', 'Customer Points History', Coins],
                ['owner', 'Owner Control Panel', SlidersHorizontal],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === id
                    ? 'bg-amber-500 text-stone-950'
                    : 'text-stone-300 hover:bg-white/5 hover:text-amber-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Tab: Result History (Last 10) */}
          {activeTab === 'history' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-amber-500/15 text-stone-400">
                    <th className="py-2 pr-3 font-medium">Round ID</th>
                    <th className="py-2 px-3 font-medium">Winning Number</th>
                    <th className="py-2 px-3 font-medium">Date</th>
                    <th className="py-2 px-3 font-medium">Time</th>
                    <th className="py-2 px-3 font-medium text-right">Total Virtual Points</th>
                    <th className="py-2 px-3 font-medium">Round Statistics</th>
                    <th className="py-2 pl-3 font-medium text-right">Verify</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-500/10">
                  {(round?.last10Results || []).map((r) => {
                    const dt = new Date(r.endedAt);
                    return (
                      <tr key={r.roundNumber} className="hover:bg-white/[0.02]">
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-stone-300">
                          #{r.roundNumber}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-bold text-amber-300">
                          {r.winningNumber}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-stone-300">
                          {dt.toLocaleDateString()}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-stone-300">
                          {dt.toLocaleTimeString()}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-stone-200">
                          {r.totalStaked.toLocaleString()} POINTS
                        </td>
                        <td className="py-2.5 px-3 text-stone-300">
                          Awarded {r.totalAwarded.toLocaleString()} PTS · {r.zeroSelectionCount} zero-pick
                          numbers
                        </td>
                        <td className="py-2.5 pl-3 text-right">
                          <button
                            type="button"
                            onClick={() => setVerifyRound(r)}
                            className="inline-flex items-center gap-1 text-amber-300 hover:underline cursor-pointer"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            Verify
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Tab: Number Statistics (0-9), Individual Entries, Customer Details & Low/Zero Stats */}
          {activeTab === 'numbers' && round && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <div className="rounded-lg border border-cyan-500/35 bg-cyan-950/20 p-3">
                  <span className="text-cyan-300 block font-semibold">
                    Zero Points / No Customer Selections
                  </span>
                  <span className="mt-1 block font-mono font-bold text-cyan-100">
                    {round.zeroSelectionNumbers.length > 0
                      ? round.zeroSelectionNumbers.join(', ')
                      : 'None (All 10 selected)'}
                  </span>
                </div>
                <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/20 p-3">
                  <span className="text-emerald-300 block font-semibold">
                    Low Points Numbers (Current)
                  </span>
                  <span className="mt-1 block font-mono font-bold text-emerald-100">
                    {round.lowPointNumbers.length > 0 ? round.lowPointNumbers.join(', ') : 'None'}
                  </span>
                </div>
                <div className="rounded-lg border border-rose-500/35 bg-rose-950/20 p-3">
                  <span className="text-rose-300 block font-semibold">
                    High Points Numbers (Current)
                  </span>
                  <span className="mt-1 block font-mono font-bold text-rose-100">
                    {round.highPointNumbers.length > 0 ? round.highPointNumbers.join(', ') : 'None'}
                  </span>
                </div>
                <div className="rounded-lg border border-amber-500/25 bg-[#0B0806] p-3">
                  <span className="text-stone-400 block">Previous Round Result</span>
                  <span className="mt-1 block font-mono text-stone-200">
                    {round.previousRoundStats
                      ? `Round #${round.previousRoundStats.roundNumber} · Winner #${round.previousRoundStats.winningNumber} · ${round.previousRoundStats.totalStaked.toLocaleString()} PTS`
                      : 'No prior round yet'}
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-amber-500/15 text-stone-400">
                      <th className="py-2 pr-3 font-medium">Number</th>
                      <th className="py-2 px-3 font-medium">Category</th>
                      <th className="py-2 px-3 font-medium">Individual Point Entries</th>
                      <th className="py-2 px-3 font-medium text-right">Round Total</th>
                      <th className="py-2 px-3 font-medium text-right">Selections</th>
                      <th className="py-2 px-3 font-medium">Customer Selection Details</th>
                      <th className="py-2 pl-3 font-medium text-right">All-Time Wins</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {round.currentNumberTotals.map((cell) => {
                      const stat = round.numberStats.find((ns) => ns.number === cell.number);
                      const customerMap = new Map<string, number[]>();
                      for (const entry of cell.entries) {
                        const arr = customerMap.get(entry.username) || [];
                        arr.push(entry.pointsStaked);
                        customerMap.set(entry.username, arr);
                      }
                      const customerSummary = Array.from(customerMap.entries())
                        .map(([name, pts]) => `${name}: ${pts.join(', ')}`)
                        .join(' · ');

                      const tierBadge =
                        cell.tier === 'high'
                          ? {
                              label: 'High Points',
                              cls: 'bg-rose-950/70 text-rose-300 border-rose-500/50',
                            }
                          : cell.tier === 'low'
                            ? {
                                label: 'Low Points',
                                cls: 'bg-emerald-950/70 text-emerald-300 border-emerald-500/50',
                              }
                            : cell.tier === 'medium'
                              ? {
                                  label: 'Medium Points',
                                  cls: 'bg-amber-950/70 text-amber-300 border-amber-500/50',
                                }
                              : {
                                  label: 'Zero / No Picks',
                                  cls: 'bg-cyan-950/70 text-cyan-300 border-cyan-500/50',
                                };

                      return (
                        <tr key={cell.number} className="hover:bg-white/[0.02]">
                          <td className="py-2.5 pr-3 font-mono font-bold text-amber-300 text-sm">
                            #{cell.number}
                          </td>
                          <td className="py-2.5 px-3">
                            <span
                              className={`inline-block px-2 py-0.5 rounded border text-[10px] font-semibold ${tierBadge.cls}`}
                            >
                              {tierBadge.label}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-stone-200">
                            {cell.entries.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {cell.entries.map((e) => (
                                  <span
                                    key={e.id}
                                    className="px-1.5 py-0.5 rounded bg-[#1D1510] border border-amber-500/20 text-[11px] tabular-nums"
                                  >
                                    {e.pointsStaked.toLocaleString()}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-stone-500">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right font-bold text-amber-200">
                            {cell.totalPoints.toLocaleString()} PTS
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right text-stone-300">
                            {cell.selectionCount}
                          </td>
                          <td className="py-2.5 px-3 text-stone-300 max-w-xs">
                            {customerSummary || (
                              <span className="text-cyan-300/75">No customer selections</span>
                            )}
                          </td>
                          <td className="py-2.5 pl-3 font-mono tabular-nums text-right text-emerald-400">
                            {stat?.winCount ?? 0}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab: Daily & Weekly Reports */}
          {activeTab === 'reports' && round && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div>
                <h3 className="text-xs font-semibold tracking-wider text-amber-300 mb-2">
                  DAILY REPORTS
                </h3>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-amber-500/15 text-stone-400">
                      <th className="py-2 pr-2 font-medium">Date</th>
                      <th className="py-2 px-2 font-medium text-right">Rounds</th>
                      <th className="py-2 px-2 font-medium text-right">Selected</th>
                      <th className="py-2 px-2 font-medium text-right">Rewards</th>
                      <th className="py-2 pl-2 font-medium text-right">Sim Profit / Loss</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {round.dailyReports.map((d) => (
                      <tr key={d.label}>
                        <td className="py-2 pr-2 font-mono text-stone-200">{d.label}</td>
                        <td className="py-2 px-2 font-mono tabular-nums text-right text-stone-300">
                          {d.roundsCount}
                        </td>
                        <td className="py-2 px-2 font-mono tabular-nums text-right text-stone-200">
                          {d.totalStaked.toLocaleString()}
                        </td>
                        <td className="py-2 px-2 font-mono tabular-nums text-right text-amber-300">
                          {d.totalAwarded.toLocaleString()}
                        </td>
                        <td className="py-2 pl-2 font-mono tabular-nums text-right text-stone-300">
                          +{d.simulatedProfit.toLocaleString()} / -{d.simulatedLoss.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h3 className="text-xs font-semibold tracking-wider text-amber-300 mb-2">
                  WEEKLY REPORTS
                </h3>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-amber-500/15 text-stone-400">
                      <th className="py-2 pr-2 font-medium">Week</th>
                      <th className="py-2 px-2 font-medium text-right">Rounds</th>
                      <th className="py-2 px-2 font-medium text-right">Selected</th>
                      <th className="py-2 px-2 font-medium text-right">Rewards</th>
                      <th className="py-2 pl-2 font-medium text-right">Sim Profit / Loss</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {round.weeklyReports.map((w) => (
                      <tr key={w.label}>
                        <td className="py-2 pr-2 font-mono text-stone-200">{w.label}</td>
                        <td className="py-2 px-2 font-mono tabular-nums text-right text-stone-300">
                          {w.roundsCount}
                        </td>
                        <td className="py-2 px-2 font-mono tabular-nums text-right text-stone-200">
                          {w.totalStaked.toLocaleString()}
                        </td>
                        <td className="py-2 px-2 font-mono tabular-nums text-right text-amber-300">
                          {w.totalAwarded.toLocaleString()}
                        </td>
                        <td className="py-2 pl-2 font-mono tabular-nums text-right text-stone-300">
                          +{w.simulatedProfit.toLocaleString()} / -{w.simulatedLoss.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab: Customer Points History */}
          {activeTab === 'customer' && (
            <div className="overflow-x-auto">
              {userHistory.length === 0 ? (
                <p className="py-8 text-center text-xs text-stone-400">
                  No virtual points entries recorded yet for {user?.username || 'current player'}.
                </p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-amber-500/15 text-stone-400">
                      <th className="py-2 pr-3 font-medium">Round</th>
                      <th className="py-2 px-3 font-medium">Number</th>
                      <th className="py-2 px-3 font-medium text-right">Points Used</th>
                      <th className="py-2 px-3 font-medium text-right">Reward Points</th>
                      <th className="py-2 pl-3 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {userHistory.map((h) => (
                      <tr key={h.id}>
                        <td className="py-2 pr-3 font-mono text-stone-300">#{h.roundNumber}</td>
                        <td className="py-2 px-3 font-mono font-bold text-amber-300">
                          #{h.selectedNumber}
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums text-right text-stone-200">
                          {h.pointsStaked.toLocaleString()} PTS
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums text-right text-emerald-400">
                          {h.pointsWon > 0 ? `+${h.pointsWon.toLocaleString()} PTS` : '0 PTS'}
                        </td>
                        <td className="py-2 pl-3 text-right uppercase text-stone-300">
                          {h.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Tab: Owner Control Panel (Same Screen) */}
          {activeTab === 'owner' && round && (
            <OwnerControlDock
              ownerSummary={round.ownerSummary}
              adminToken={adminToken}
              onAdminTokenChange={setAdminToken}
              onRoundSync={(nextRound) => setRound(nextRound)}
              onJumpToTab={(t) => setActiveTab(t)}
            />
          )}
        </section>
      </main>

      {/* Modals */}
      <FairnessModal round={verifyRound} onClose={() => setVerifyRound(null)} />
      {authModalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-amber-500/35 bg-[#120D09] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-amber-500/15 pb-3">
              <h2
                className="text-lg font-bold text-amber-100"
                style={{fontFamily: 'var(--font-display)'}}
              >
                {authModalMode === 'login' ? 'Customer Profile Sign In' : 'Create Demo Profile'}
              </h2>
              <button
                type="button"
                onClick={() => setAuthModalMode(null)}
                aria-label="Close modal"
                className="p-1 text-stone-400 hover:text-amber-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#070504] border border-amber-500/20">
              <button
                type="button"
                onClick={() => {
                  setAuthError('');
                  setAuthModalMode('login');
                }}
                className={`py-2 rounded-md text-xs font-semibold cursor-pointer ${
                  authModalMode === 'login' ? 'bg-amber-500 text-stone-950' : 'text-stone-300'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthError('');
                  setAuthModalMode('register');
                }}
                className={`py-2 rounded-md text-xs font-semibold cursor-pointer ${
                  authModalMode === 'register' ? 'bg-amber-500 text-stone-950' : 'text-stone-300'
                }`}
              >
                New Profile (5,000 PTS)
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              <div>
                <label className="block text-xs text-stone-400 mb-1">Username</label>
                <input
                  type="text"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  required
                  placeholder="Player name"
                  className="w-full rounded-lg border border-amber-500/25 bg-[#070504] px-3 py-2 text-sm text-stone-100"
                />
              </div>
              {authModalMode === 'register' && (
                <div>
                  <label className="block text-xs text-stone-400 mb-1">Email (optional)</label>
                  <input
                    type="email"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="player@local"
                    className="w-full rounded-lg border border-amber-500/25 bg-[#070504] px-3 py-2 text-sm text-stone-100"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs text-stone-400 mb-1">Password</label>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full rounded-lg border border-amber-500/25 bg-[#070504] px-3 py-2 text-sm text-stone-100"
                />
              </div>
              {authError && <p className="text-xs text-red-400">{authError}</p>}
              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full py-2.5 rounded-lg bg-amber-500 text-stone-950 text-xs font-bold hover:bg-amber-400 cursor-pointer"
              >
                {authSubmitting
                  ? 'Please wait...'
                  : authModalMode === 'login'
                    ? 'Sign In'
                    : 'Create Profile'}
              </button>
            </form>
          </div>
        </div>
      )}
      <OfflineIndicator />
    </div>
  );
}
