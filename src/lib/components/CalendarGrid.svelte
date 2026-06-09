<script lang="ts">
  /**
   * Shared calendar grid component used in both Ingest (discover) and Review (upcoming).
   * Supports month, week, and day views.
   */

  type CalEvent = {
    id: string;
    title: string;
    start: Date;
    end?: Date;
    source?: string;
    conflict?: boolean;
    inKb?: boolean;
    recurring?: boolean;
    recurrencePattern?: string;
  };

  type ViewMode = 'month' | 'week' | 'day';

  let {
    events = [],
    viewMode = 'month',
    currentDate = new Date(),
    onselect,
    onadd
  } = $props<{
    events?: CalEvent[];
    viewMode?: ViewMode;
    currentDate?: Date;
    onselect?: (ev: CalEvent) => void;
    onadd?: (ev: CalEvent) => void;
  }>();

  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const year = $derived(currentDate.getFullYear());
  const month = $derived(currentDate.getMonth());

  function dateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function isToday(d: Date): boolean {
    const t = new Date();
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  }

  function hourLabel(h: number): string {
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12} ${ampm}`;
  }

  function formatTime(d: Date): string {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // Month grid: 6x7 = 42 cells
  const monthDays = $derived.by(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = firstDay.getDay();
    const daysInMonth = lastDay.getDate();
    const days: { date: number; fullDate: Date; isCurrentMonth: boolean }[] = [];

    const prevLast = new Date(year, month, 0).getDate();
    for (let i = startDow - 1; i >= 0; i--) {
      days.push({ date: prevLast - i, fullDate: new Date(year, month - 1, prevLast - i), isCurrentMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      days.push({ date: d, fullDate: new Date(year, month, d), isCurrentMonth: true });
    }
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) {
      days.push({ date: d, fullDate: new Date(year, month + 1, d), isCurrentMonth: false });
    }
    return days;
  });

  // Week days for week view
  const weekStart = $derived.by(() => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const weekDates = $derived.by(() => {
    const dates: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }
    return dates;
  });

  // Group events by date
  const eventsByDate = $derived.by(() => {
    const grouped: Record<string, CalEvent[]> = {};
    for (const ev of events) {
      const key = dateKey(ev.start);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(ev);
    }
    return grouped;
  });

  // Events for current day (day view)
  const dayEvents = $derived.by(() => {
    const key = dateKey(currentDate);
    return (eventsByDate[key] ?? []).sort((a, b) => a.start.getTime() - b.start.getTime());
  });

  // Hours for day/week time slots
  const hours = Array.from({ length: 24 }, (_, i) => i);
</script>

<!-- Month View -->
{#if viewMode === 'month'}
  <div class="cal-grid">
    {#each weekDays as day}
      <div class="cal-dow">{day}</div>
    {/each}

    {#each monthDays as day}
      {@const dayEvs = eventsByDate[dateKey(day.fullDate)] ?? []}
      <div class="cal-cell" class:other-month={!day.isCurrentMonth} class:today={isToday(day.fullDate)}>
        <span class="cal-date">{day.date}</span>
        {#each dayEvs.slice(0, 3) as ev}
          <button
            class="cal-event"
            class:conflict={ev.conflict}
            class:in-kb={ev.inKb}
            class:recurring={ev.recurring}
            title={ev.recurring ? `${ev.title} (${ev.recurrencePattern ?? 'recurring'})` : ev.title}
            onclick={() => onselect?.(ev)}
          >
            {#if ev.recurring}<span class="cal-recur">&#8634;</span>{/if}
            <span class="cal-event-time">{formatTime(ev.start)}</span>
            <span class="cal-event-title">{ev.title}</span>
          </button>
        {/each}
        {#if dayEvs.length > 3}
          <span class="cal-more">+{dayEvs.length - 3} more</span>
        {/if}
      </div>
    {/each}
  </div>

<!-- Week View -->
{:else if viewMode === 'week'}
  <div class="week-grid">
    <div class="week-header">
      <div class="time-gutter"></div>
      {#each weekDates as wd}
        <div class="week-day-header" class:today={isToday(wd)}>
          <span class="dow">{weekDays[wd.getDay()]}</span>
          <span class="dom">{wd.getDate()}</span>
        </div>
      {/each}
    </div>
    <div class="week-body">
      <div class="time-gutter">
        {#each hours as h}
          <div class="hour-label">{hourLabel(h)}</div>
        {/each}
      </div>
      {#each weekDates as wd, colIdx}
        <div class="week-col">
          {#each hours as h}
            <div class="hour-slot"></div>
          {/each}
          <!-- Events positioned absolutely -->
          {#each (eventsByDate[dateKey(wd)] ?? []) as ev}
            {@const top = (ev.start.getHours() + ev.start.getMinutes() / 60) * 3}
            {@const duration = ev.end ? (ev.end.getTime() - ev.start.getTime()) / 3600000 : 1}
            {@const height = Math.max(duration * 3, 1.5)}
            <button
              class="week-event"
              class:conflict={ev.conflict}
              class:in-kb={ev.inKb}
              class:recurring={ev.recurring}
              title={ev.recurring ? `${ev.title} (${ev.recurrencePattern ?? 'recurring'})` : ev.title}
              style="top: {top}rem; height: {height}rem;"
              onclick={() => onselect?.(ev)}
            >
              <span class="we-time">{#if ev.recurring}<span class="cal-recur">&#8634;</span>{/if}{formatTime(ev.start)}</span>
              <span class="we-title">{ev.title}</span>
            </button>
          {/each}
        </div>
      {/each}
    </div>
  </div>

<!-- Day View -->
{:else}
  <div class="day-grid">
    <div class="day-header">
      <span class="day-label">{weekDays[currentDate.getDay()]}, {monthNames[month]} {currentDate.getDate()}</span>
    </div>
    <div class="day-body">
      {#each hours as h}
        <div class="day-row">
          <span class="hour-label">{hourLabel(h)}</span>
          <div class="hour-slot"></div>
        </div>
      {/each}
      <!-- Events -->
      {#each dayEvents as ev}
        {@const top = (ev.start.getHours() + ev.start.getMinutes() / 60) * 3.5}
        {@const duration = ev.end ? (ev.end.getTime() - ev.start.getTime()) / 3600000 : 1}
        {@const height = Math.max(duration * 3.5, 2)}
        <button
          class="day-event"
          class:conflict={ev.conflict}
          class:in-kb={ev.inKb}
          class:recurring={ev.recurring}
          title={ev.recurring ? `${ev.title} (${ev.recurrencePattern ?? 'recurring'})` : ev.title}
          style="top: calc(2.5rem + {top}rem); height: {height}rem;"
          onclick={() => onselect?.(ev)}
        >
          <span class="de-time">{#if ev.recurring}<span class="cal-recur">&#8634;</span>{/if}{formatTime(ev.start)}{ev.end ? ` - ${formatTime(ev.end)}` : ''}</span>
          <span class="de-title">{ev.title}</span>
          {#if ev.conflict}
            <span class="de-conflict">CONFLICT</span>
          {/if}
          {#if onadd && !ev.inKb}
            <button class="de-add" onclick={(e) => { e.stopPropagation(); onadd?.(ev); }}>+ add</button>
          {/if}
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* ── Month ── */
  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
    background: var(--line);
    border-radius: var(--rad-sm);
    overflow: hidden;
  }
  .cal-dow {
    padding: 0.4rem;
    text-align: center;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--muted);
    background: var(--surface-2);
  }
  .cal-cell {
    min-height: 5.5rem;
    padding: 0.3rem;
    background: var(--surface);
  }
  .cal-cell.other-month { background: var(--surface-2); opacity: 0.5; }
  .cal-cell.today { box-shadow: inset 0 0 0 2px var(--accent); }
  .cal-date { font-size: 0.7rem; font-weight: 600; color: var(--ink-2); display: block; margin-bottom: 0.2rem; }
  .cal-event {
    display: block;
    width: 100%;
    text-align: left;
    font-size: 0.65rem;
    padding: 2px 4px;
    margin-bottom: 2px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
    border: none;
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .cal-event.conflict { background: color-mix(in srgb, var(--danger) 20%, var(--surface)); color: var(--danger); }
  .cal-event.in-kb { background: color-mix(in srgb, var(--ok) 15%, var(--surface)); color: var(--ok); }
  .cal-event-time { opacity: 0.7; margin-right: 3px; }
  .cal-event-title { font-weight: 500; }
  .cal-more { font-size: 0.6rem; color: var(--muted); }

  /* ── Week ── */
  .week-grid { border: 1px solid var(--line); border-radius: var(--rad-sm); overflow: hidden; }
  .week-header {
    display: grid;
    grid-template-columns: 3.5rem repeat(7, 1fr);
    border-bottom: 1px solid var(--line);
    background: var(--surface-2);
  }
  .time-gutter { display: flex; flex-direction: column; }
  .week-day-header {
    padding: 0.4rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .week-day-header.today { color: var(--accent); font-weight: 600; }
  .week-day-header .dow { display: block; font-size: 0.65rem; text-transform: uppercase; }
  .week-day-header .dom { font-size: 1rem; font-weight: 700; color: var(--ink); }
  .week-body {
    display: grid;
    grid-template-columns: 3.5rem repeat(7, 1fr);
    max-height: 36rem;
    overflow-y: auto;
  }
  .week-body .time-gutter { background: var(--surface-2); }
  .hour-label {
    height: 3rem;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 0 0.4rem;
    font-size: 0.6rem;
    color: var(--muted-2);
  }
  .week-col {
    position: relative;
    border-left: 1px solid var(--line);
  }
  .hour-slot {
    height: 3rem;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent);
  }
  .week-event {
    position: absolute;
    left: 2px;
    right: 2px;
    border-radius: 3px;
    padding: 2px 4px;
    font-size: 0.6rem;
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
    cursor: pointer;
    overflow: hidden;
    text-align: left;
  }
  .week-event.conflict { background: color-mix(in srgb, var(--danger) 20%, var(--surface)); color: var(--danger); border-color: var(--danger); }
  .week-event.in-kb { background: color-mix(in srgb, var(--ok) 15%, var(--surface)); color: var(--ok); border-color: var(--ok); }
  .we-time { font-size: 0.55rem; opacity: 0.7; display: block; }
  .we-title { font-weight: 500; }

  /* ── Day ── */
  .day-grid { border: 1px solid var(--line); border-radius: var(--rad-sm); overflow: hidden; }
  .day-header {
    padding: 0.75rem 1rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
  }
  .day-label { font-family: var(--font-display); font-size: 1.1rem; }
  .day-body {
    position: relative;
    max-height: 40rem;
    overflow-y: auto;
  }
  .day-row {
    display: flex;
    height: 3.5rem;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent);
  }
  .day-row .hour-label {
    width: 4rem;
    flex-shrink: 0;
    height: 3.5rem;
    padding: 0.2rem 0.5rem;
    font-size: 0.65rem;
    color: var(--muted-2);
    text-align: right;
    background: var(--surface-2);
  }
  .day-row .hour-slot { flex: 1; }
  .day-event {
    position: absolute;
    left: 4.5rem;
    right: 0.5rem;
    border-radius: var(--rad-sm);
    padding: 0.4rem 0.6rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--accent);
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .day-event.conflict { background: color-mix(in srgb, var(--danger) 15%, var(--surface)); border-color: var(--danger); color: var(--danger); }
  .day-event.in-kb { background: color-mix(in srgb, var(--ok) 12%, var(--surface)); border-color: var(--ok); color: var(--ok); }
  .de-time { font-size: 0.7rem; opacity: 0.8; }
  .de-title { font-size: 0.8rem; font-weight: 600; }
  .de-conflict { font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .de-add {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    font-size: 0.6rem;
    padding: 0.15rem 0.4rem;
    border-radius: 3px;
    background: var(--accent);
    color: var(--bg);
    border: none;
    cursor: pointer;
  }

  /* Recurring event indicator */
  .cal-recur {
    font-size: 0.7em;
    opacity: 0.7;
    margin-right: 2px;
  }
  .cal-event.recurring,
  .week-event.recurring,
  .day-event.recurring {
    border-left: 2px solid var(--data);
  }
  .cal-event.recurring { padding-left: 3px; }
  .week-event.recurring { border-left-width: 2px; }
  .day-event.recurring { border-left-width: 3px; }
</style>
