import {
  Component, inject, signal, computed,
  ViewChild, ElementRef, effect,
  AfterViewInit, OnDestroy, ChangeDetectionStrategy,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
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
  date: string;       // YYYY-MM-DD
  wordsAdded: number;
}

interface StatsSummary {
  totalWordsAdded: number;
  activeDays: number;
  totalVersionsSaved: number;
  currentStreak: number;
}

interface StatsResponse {
  daily: DailyStats[];
  summary: StatsSummary;
}

type Range = 30 | 90 | 365;

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

@Component({
  selector: 'app-writing-stats-dialog',
  imports: [DecimalPipe, MatButtonModule, MatDialogModule, MatIconModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Writing Stats</h2>

    <mat-dialog-content>
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
          <mat-spinner diameter="48" />
        </div>
      } @else if (errorMsg()) {
        <p class="error-msg">{{ errorMsg() }}</p>
      } @else {
        <div class="stat-cards" aria-label="Summary statistics">
          <div class="stat-card">
            <mat-icon aria-hidden="true">edit_note</mat-icon>
            <span class="stat-value">{{ summary().totalWordsAdded | number }}</span>
            <span class="stat-label">Words Written</span>
          </div>
          <div class="stat-card">
            <mat-icon aria-hidden="true">event_available</mat-icon>
            <span class="stat-value">{{ summary().activeDays }}</span>
            <span class="stat-label">Active Days</span>
          </div>
          <div class="stat-card">
            <mat-icon aria-hidden="true">trending_up</mat-icon>
            <span class="stat-value">{{ summary().avgPerDay | number }}</span>
            <span class="stat-label">Avg Words/Day</span>
          </div>
          <div class="stat-card">
            <mat-icon aria-hidden="true">local_fire_department</mat-icon>
            <span class="stat-value">{{ allData()?.summary?.currentStreak ?? 0 }}</span>
            <span class="stat-label">Day Streak</span>
          </div>
        </div>

        <div class="chart-wrap">
          <canvas #chartCanvas aria-label="Words written over time" role="img"></canvas>
        </div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      width: min(800px, 90vw);
      box-sizing: border-box;
      min-height: 340px;
    }

    .range-row {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;

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
      min-height: 260px;
    }

    .error-msg {
      color: var(--mat-sys-error);
      text-align: center;
      padding: 48px 0;
    }

    .stat-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 24px;

      @media (max-width: 540px) {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .stat-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 8px;
      border-radius: 8px;
      background: var(--mat-sys-surface-container);

      mat-icon {
        color: var(--mat-sys-primary);
        font-size: 22px;
        width: 22px;
        height: 22px;
      }
    }

    .stat-value {
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface);
      line-height: 1;
    }

    .stat-label {
      font-size: 0.75rem;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }

    .chart-wrap {
      position: relative;
      height: 220px;
    }
  `],
})
export class WritingStatsDialogComponent implements AfterViewInit, OnDestroy {
  private http = inject(HttpClient);

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
    const cutoffStr = localDateStr(cutoff);
    return data.daily.filter(d => d.date >= cutoffStr);
  });

  summary = computed(() => {
    const daily = this.filteredDaily();
    const totalWordsAdded = daily.reduce((s, d) => s + d.wordsAdded, 0);
    const activeDays = daily.filter(d => d.wordsAdded > 0).length;
    const avgPerDay = activeDays > 0 ? Math.round(totalWordsAdded / activeDays) : 0;
    return { totalWordsAdded, activeDays, avgPerDay };
  });

  private chart?: Chart;

  constructor() {
    effect(() => {
      const ready = this.viewReady();
      const data = this.filteredDaily(); // track for re-render on range change
      if (ready && !this.loading() && data !== undefined) {
        setTimeout(() => this.renderChart(), 0);
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
    this.loadData();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  setRange(r: Range): void {
    this.range.set(r);
  }

  private loadData(): void {
    this.http.get<StatsResponse>(`/api/user-stats/writing?days=365&tz=${encodeURIComponent(localTz)}`).subscribe({
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

  private getChartData(): { labels: string[]; values: number[] } {
    const r = this.range();
    const daily = this.filteredDaily();

    if (r === 365) {
      // Aggregate by month and fill all 12 months in window
      const map = new Map<string, number>();
      for (const d of daily) {
        const key = d.date.slice(0, 7); // YYYY-MM
        map.set(key, (map.get(key) ?? 0) + d.wordsAdded);
      }
      const labels: string[] = [];
      const values: number[] = [];
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        labels.push(d.toLocaleString('default', { month: 'short' }) + ' \'' + String(d.getFullYear()).slice(2));
        values.push(map.get(key) ?? 0);
      }
      return { labels, values };
    }

    // Daily with zero-fill for 30 / 90 day views
    const dataMap = new Map(daily.map(d => [d.date, d.wordsAdded]));
    const labels: string[] = [];
    const values: number[] = [];
    const now = new Date();
    for (let i = r - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ds = localDateStr(d);
      labels.push(ds.slice(5).replace('-', '/'));
      values.push(dataMap.get(ds) ?? 0);
    }
    return { labels, values };
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

    const { labels, values } = this.getChartData();
    const onSurfaceVariant = this.resolveColor('--mat-sys-on-surface-variant', 'rgba(128,128,128,0.9)');
    const outlineVariant   = this.resolveColor('--mat-sys-outline-variant', 'rgba(128,128,128,0.25)');

    this.chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Words written',
          data: values,
          backgroundColor: 'rgba(103, 80, 164, 0.75)',
          borderColor: 'rgba(103, 80, 164, 1)',
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${(ctx.parsed.y as number).toLocaleString()} words`,
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
