import {
  Component, inject, signal, computed,
  ViewChild, ElementRef, effect,
  AfterViewInit, OnDestroy, ChangeDetectionStrategy, OnInit,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HeaderService } from '../services/header.service';
import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

interface DailyStats {
  date: string;         // YYYY-MM-DD
  wordsAdded: number;
  wordsDeleted: number;
}

interface ChapterStats {
  chapterId: string;
  title: string;
  thumbnailUrl: string | null;
  wordsAdded: number;
  wordsDeleted: number;
  netWords: number;
  lastSaved: string;    // YYYY-MM-DD
}

interface StatsSummary {
  totalAdded: number;
  totalDeleted: number;
  netWords: number;
  activeDays: number;
  totalVersionsSaved: number;
  currentStreak: number;
}

interface StatsResponse {
  daily: DailyStats[];
  byChapter: ChapterStats[];
  summary: StatsSummary;
}

type Range = 30 | 90 | 365;

interface PeriodBucket {
  label: string;
  added: number;
  deleted: number;
}

@Component({
  selector: 'app-writing-stats',
  imports: [DecimalPipe, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'writing-stats-host' },
  template: `
    <div class="stats-page">
      <h2 class="page-title">Writing Stats</h2>

      <div class="range-row" role="group" aria-label="Time range">
        @for (opt of rangeOptions; track opt.value) {
          <button mat-stroked-button
                  [class.active]="range() === opt.value"
                  (click)="setRange(opt.value)">
            {{ opt.label }}
          </button>
        }
      </div>

      @if (loading()) {
        <div class="center-spinner" aria-label="Loading stats">
          <mat-spinner diameter="56" />
        </div>
      } @else if (errorMsg()) {
        <p class="error-msg">{{ errorMsg() }}</p>
      } @else {
        <div class="stat-cards" aria-label="Summary statistics">
          <div class="stat-card added">
            <mat-icon aria-hidden="true">add_circle_outline</mat-icon>
            <span class="stat-value">{{ summary().totalAdded | number }}</span>
            <span class="stat-label">Words Added</span>
          </div>
          <div class="stat-card deleted">
            <mat-icon aria-hidden="true">remove_circle_outline</mat-icon>
            <span class="stat-value">{{ summary().totalDeleted | number }}</span>
            <span class="stat-label">Words Deleted</span>
          </div>
          <div class="stat-card net">
            <mat-icon aria-hidden="true">swap_vert</mat-icon>
            <span class="stat-value" [class.negative]="summary().net < 0">
              {{ summary().net >= 0 ? '+' : '' }}{{ summary().net | number }}
            </span>
            <span class="stat-label">Net Change</span>
          </div>
          <div class="stat-card">
            <mat-icon aria-hidden="true">local_fire_department</mat-icon>
            <span class="stat-value">{{ allData()?.summary?.currentStreak ?? 0 }}</span>
            <span class="stat-label">Day Streak</span>
          </div>
        </div>

        <div class="chart-section">
          <div class="chart-legend">
            <span class="legend-dot added"></span> Added
            <span class="legend-dot deleted"></span> Deleted
          </div>
          <div class="chart-wrap">
            <canvas #chartCanvas
                    [attr.aria-label]="'Words added and deleted per ' + (range() === 365 ? 'month' : 'day')"
                    role="img"></canvas>
          </div>
        </div>

        @if (allData()?.byChapter?.length) {
          <div class="chapter-section">
            <h3 class="chapter-section-title">By Chapter</h3>
            <div class="chapter-table" role="table" aria-label="Word counts by chapter">
              <div class="chapter-table-head" role="row">
                <span role="columnheader" aria-label="Cover"></span>
                <span role="columnheader">Chapter</span>
                <span role="columnheader">Added</span>
                <span role="columnheader">Deleted</span>
                <span role="columnheader">Net</span>
                <span role="columnheader">Last edited</span>
              </div>
              @for (ch of allData()!.byChapter; track ch.chapterId) {
                <div class="chapter-row" role="row">
                  <span class="ch-thumb" role="cell">
                    @if (ch.thumbnailUrl) {
                      <img [src]="ch.thumbnailUrl" [alt]="ch.title" class="ch-thumb-img" />
                    } @else {
                      <span class="ch-thumb-placeholder" aria-hidden="true">
                        <mat-icon>menu_book</mat-icon>
                      </span>
                    }
                  </span>
                  <span class="ch-title" role="cell" [title]="ch.title">{{ ch.title }}</span>
                  <span class="ch-added" role="cell">{{ fmtCount(ch.wordsAdded, '+') }}</span>
                  <span class="ch-deleted" role="cell">{{ fmtCount(ch.wordsDeleted, '−') }}</span>
                  <span class="ch-net" role="cell"
                        [class.positive]="ch.netWords > 0"
                        [class.negative]="ch.netWords < 0">
                    {{ fmtCount(ch.netWords, ch.netWords >= 0 ? '+' : '') }}
                  </span>
                  <span class="ch-date" role="cell">{{ ch.lastSaved }}</span>
                </div>
              }
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host.writing-stats-host {
      display: block;
      height: 100%;
      overflow-y: auto;
    }

    .stats-page {
      max-width: 860px;
      margin: 0 auto;
      padding: 24px 16px;
      box-sizing: border-box;
    }

    .page-title {
      margin: 0 0 20px;
      font-size: 1.5rem;
      font-weight: 500;
    }

    .range-row {
      display: flex;
      gap: 8px;
      margin-bottom: 28px;
      flex-wrap: wrap;

      button.active {
        background: var(--mat-sys-primary-container);
        color: var(--mat-sys-on-primary-container);
        border-color: var(--mat-sys-primary);
      }
    }

    .center-spinner {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 300px;
    }

    .error-msg {
      color: var(--mat-sys-error);
      text-align: center;
      padding: 64px 0;
    }

    .stat-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 32px;

      @media (max-width: 560px) {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .stat-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 16px 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);

      mat-icon {
        font-size: 28px;
        width: 28px;
        height: 28px;
        color: var(--mat-sys-primary);
      }

      &.added mat-icon { color: #4caf50; }
      &.deleted mat-icon { color: #e57373; }
      &.net mat-icon { color: var(--mat-sys-secondary); }
    }

    .stat-value {
      font-size: 1.75rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface);
      line-height: 1;

      &.negative { color: #e57373; }
    }

    .stat-label {
      font-size: 0.75rem;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }

    .chart-section {
      background: var(--mat-sys-surface-container-low);
      border-radius: 12px;
      padding: 16px 20px 20px;
    }

    .chart-legend {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-bottom: 12px;
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
    }

    .legend-dot {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 3px;
      margin-right: 4px;

      &.added { background: rgba(79, 177, 128, 0.85); }
      &.deleted { background: rgba(229, 115, 115, 0.85); }
    }

    .chart-wrap {
      position: relative;
      height: 280px;
    }

    /* ── Chapter breakdown ─────────────────────────────── */

    .chapter-section {
      margin-top: 24px;
      background: var(--mat-sys-surface-container-low);
      border-radius: 12px;
      padding: 16px 20px 8px;
    }

    .chapter-section-title {
      margin: 0 0 14px;
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .chapter-table {
      display: flex;
      flex-direction: column;
    }

    .chapter-table-head,
    .chapter-row {
      display: grid;
      grid-template-columns: 44px 1fr 80px 80px 80px 90px;
      gap: 8px;
      align-items: center;
      padding: 8px 4px;
      font-size: 0.85rem;

      @media (max-width: 600px) {
        grid-template-columns: 36px 1fr 64px 64px 64px;

        .ch-date { display: none; }
      }
    }

    .chapter-table-head {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      padding-bottom: 6px;
      margin-bottom: 2px;

      span:not(:first-child) { text-align: right; }
    }

    .ch-thumb {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .ch-thumb-img {
      width: 36px;
      height: 36px;
      border-radius: 4px;
      object-fit: cover;
      display: block;
    }

    .ch-thumb-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 4px;
      background: var(--mat-sys-surface-container);

      mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--mat-sys-on-surface-variant);
      }
    }

    .chapter-row {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface);

      &:last-child { border-bottom: none; }
      &:hover { background: var(--mat-sys-surface-container); border-radius: 6px; }
    }

    .ch-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }

    .ch-added, .ch-deleted, .ch-net, .ch-date {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .ch-added  { color: #4caf50; }
    .ch-deleted { color: #e57373; }

    .ch-net {
      font-weight: 600;
      color: var(--mat-sys-on-surface-variant);
      &.positive { color: #4caf50; }
      &.negative { color: #e57373; }
    }

    .ch-date {
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.78rem;
    }
  `],
})
export class WritingStatsComponent implements OnInit, AfterViewInit, OnDestroy {
  private http = inject(HttpClient);
  private header = inject(HeaderService);

  @ViewChild('chartCanvas') private chartCanvas!: ElementRef<HTMLCanvasElement>;

  readonly rangeOptions: { label: string; value: Range }[] = [
    { label: '30 days', value: 30 },
    { label: '90 days', value: 90 },
    { label: 'All time', value: 365 },
  ];

  loading = signal(true);
  errorMsg = signal<string | null>(null);
  allData = signal<StatsResponse | null>(null);
  range = signal<Range>(30);

  private viewReady = signal(false);

  filteredDaily = computed(() => {
    const data = this.allData();
    if (!data) return [];
    const r = this.range();
    if (r === 365) return data.daily;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - r);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return data.daily.filter(d => d.date >= cutoffStr);
  });

  summary = computed(() => {
    const daily = this.filteredDaily();
    const totalAdded   = daily.reduce((s, d) => s + d.wordsAdded, 0);
    const totalDeleted = daily.reduce((s, d) => s + d.wordsDeleted, 0);
    const net = totalAdded - totalDeleted;
    const activeDays = daily.filter(d => d.wordsAdded > 0 || d.wordsDeleted > 0).length;
    return { totalAdded, totalDeleted, net, activeDays };
  });

  private chart?: Chart;

  constructor() {
    effect(() => {
      const ready = this.viewReady();
      const _data = this.filteredDaily(); // track for re-render on range/data change
      if (ready && !this.loading()) {
        setTimeout(() => this.renderChart(), 0);
      }
    });
  }

  ngOnInit(): void {
    this.header.set([{ label: 'Writing Stats' }]);
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
    this.loadData();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.header.clear();
  }

  setRange(r: Range): void {
    this.range.set(r);
  }

  fmtCount(n: number, prefix = ''): string {
    return n === 0 ? '—' : `${prefix}${n.toLocaleString()}`;
  }

  private loadData(): void {
    this.http.get<StatsResponse>('/api/user-stats/writing?days=365').subscribe({
      next: (data) => {
        this.allData.set(data);
        this.loading.set(false);
      },
      error: () => {
        this.errorMsg.set('Failed to load writing stats. Please try again.');
        this.loading.set(false);
      },
    });
  }

  private getChartBuckets(): PeriodBucket[] {
    const r = this.range();
    const daily = this.filteredDaily();
    const now = new Date();

    if (r === 365) {
      // Aggregate by month, fill all 12 months
      const addedMap = new Map<string, number>();
      const deletedMap = new Map<string, number>();
      for (const d of daily) {
        const key = d.date.slice(0, 7);
        addedMap.set(key, (addedMap.get(key) ?? 0) + d.wordsAdded);
        deletedMap.set(key, (deletedMap.get(key) ?? 0) + d.wordsDeleted);
      }
      const buckets: PeriodBucket[] = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        buckets.push({
          label: d.toLocaleString('default', { month: 'short' }) + ' \'' + String(d.getFullYear()).slice(2),
          added: addedMap.get(key) ?? 0,
          deleted: deletedMap.get(key) ?? 0,
        });
      }
      return buckets;
    }

    // Daily with zero-fill
    const addedMap  = new Map(daily.map(d => [d.date, d.wordsAdded]));
    const deletedMap = new Map(daily.map(d => [d.date, d.wordsDeleted]));
    const buckets: PeriodBucket[] = [];
    for (let i = r - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      buckets.push({
        label: ds.slice(5).replace('-', '/'),
        added: addedMap.get(ds) ?? 0,
        deleted: deletedMap.get(ds) ?? 0,
      });
    }
    return buckets;
  }

  private resolveColor(cssVar: string, fallback: string): string {
    const el = document.createElement('div');
    el.style.cssText = `color:var(${cssVar});position:absolute;visibility:hidden`;
    document.body.appendChild(el);
    const resolved = getComputedStyle(el).color;
    document.body.removeChild(el);
    return resolved || fallback;
  }

  private renderChart(): void {
    const canvas = this.chartCanvas?.nativeElement;
    if (!canvas) return;

    this.chart?.destroy();

    const buckets = this.getChartBuckets();
    const onSurfaceVariant = this.resolveColor('--mat-sys-on-surface-variant', 'rgba(128,128,128,0.9)');
    const outlineVariant   = this.resolveColor('--mat-sys-outline-variant', 'rgba(128,128,128,0.25)');

    this.chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [
          {
            label: 'Added',
            data: buckets.map(b => b.added),
            backgroundColor: 'rgba(79, 177, 128, 0.85)',
            borderColor: 'rgba(79, 177, 128, 1)',
            borderWidth: 1,
            borderRadius: 3,
          },
          {
            label: 'Deleted',
            data: buckets.map(b => b.deleted),
            backgroundColor: 'rgba(229, 115, 115, 0.85)',
            borderColor: 'rgba(229, 115, 115, 1)',
            borderWidth: 1,
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${(ctx.parsed.y as number).toLocaleString()} words`,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: onSurfaceVariant,
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: this.range() === 365 ? 12 : 15,
            },
            grid: { color: outlineVariant },
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: onSurfaceVariant,
              callback: (v) => Number(v).toLocaleString(),
            },
            grid: { color: outlineVariant },
          },
        },
      },
    });
  }
}
