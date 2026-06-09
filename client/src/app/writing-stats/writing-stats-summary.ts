import {
  Component, inject, signal, OnInit, AfterViewInit, OnDestroy,
  ViewChild, ElementRef, ChangeDetectionStrategy,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

interface DailyEntry { date: string; wordsAdded: number; wordsDeleted: number }

interface StatsResponse {
  daily: DailyEntry[];
  summary: { currentStreak: number };
}

interface Snapshot {
  added: number;
  deleted: number;
  net: number;
  streak: number;
}

@Component({
  selector: 'app-writing-stats-summary',
  imports: [DecimalPipe, RouterLink, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wss-section">
      <div class="wss-header">
        <h3 class="wss-title">Your Writing <span class="wss-period">· past 30 days</span></h3>
        <a class="wss-link" routerLink="/writing-stats">
          See all stats
          <mat-icon aria-hidden="true">chevron_right</mat-icon>
        </a>
      </div>

      <div class="wss-cards">
        <div class="wss-card added">
          <mat-icon aria-hidden="true">add_circle_outline</mat-icon>
          <span class="wss-value">{{ snap().added | number }}</span>
          <span class="wss-label">Words Added</span>
        </div>
        <div class="wss-card deleted">
          <mat-icon aria-hidden="true">remove_circle_outline</mat-icon>
          <span class="wss-value">{{ snap().deleted | number }}</span>
          <span class="wss-label">Words Deleted</span>
        </div>
        <div class="wss-card net">
          <mat-icon aria-hidden="true">swap_vert</mat-icon>
          <span class="wss-value" [class.negative]="snap().net < 0">
            {{ snap().net >= 0 ? '+' : '' }}{{ snap().net | number }}
          </span>
          <span class="wss-label">Net Change</span>
        </div>
        <div class="wss-card streak">
          <mat-icon aria-hidden="true">local_fire_department</mat-icon>
          <span class="wss-value">{{ snap().streak }}</span>
          <span class="wss-label">Day Streak</span>
        </div>
      </div>

      <div class="wss-chart-wrap">
        <canvas #chartCanvas aria-label="Net words changed per day" role="img"></canvas>
      </div>
    </div>
  `,
  styles: [`
    .wss-section {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }

    .wss-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }

    .wss-title {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface);
    }

    .wss-period {
      font-weight: 400;
      color: var(--mat-sys-on-surface-variant);
    }

    .wss-link {
      display: flex;
      align-items: center;
      gap: 2px;
      font-size: 0.85rem;
      color: var(--mat-sys-primary);
      text-decoration: none;

      mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }

      &:hover { text-decoration: underline; }
    }

    .wss-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 16px;

      @media (max-width: 520px) {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .wss-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 14px 10px;
      border-radius: 10px;
      background: var(--mat-sys-surface-container);

      mat-icon {
        font-size: 22px;
        width: 22px;
        height: 22px;
        color: var(--mat-sys-primary);
      }

      &.added mat-icon  { color: #4caf50; }
      &.deleted mat-icon { color: #e57373; }
      &.streak mat-icon  { color: #ff9800; }
    }

    .wss-value {
      font-size: 1.4rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface);
      line-height: 1;

      &.negative { color: #e57373; }
    }

    .wss-label {
      font-size: 0.7rem;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }

    .wss-chart-wrap {
      position: relative;
      height: 160px;
    }
  `],
})
export class WritingStatsSummaryComponent implements OnInit, AfterViewInit, OnDestroy {
  private http = inject(HttpClient);

  @ViewChild('chartCanvas') private chartCanvas!: ElementRef<HTMLCanvasElement>;

  snap = signal<Snapshot>({ added: 0, deleted: 0, net: 0, streak: 0 });

  private dailyData: DailyEntry[] = [];
  private viewReady = false;
  private chart?: Chart;

  ngOnInit(): void {
    this.http.get<StatsResponse>('/api/user-stats/writing?days=30').subscribe({
      next: ({ daily, summary }) => {
        this.dailyData = daily;
        const added   = daily.reduce((s, d) => s + d.wordsAdded, 0);
        const deleted = daily.reduce((s, d) => s + d.wordsDeleted, 0);
        this.snap.set({ added, deleted, net: added - deleted, streak: summary.currentStreak });
        if (this.viewReady) setTimeout(() => this.renderChart(), 0);
      },
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    if (this.dailyData.length) setTimeout(() => this.renderChart(), 0);
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
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

    // Build a zero-filled 30-day series
    const dataMap = new Map(
      this.dailyData.map(d => [d.date, d.wordsAdded - d.wordsDeleted])
    );
    const labels: string[] = [];
    const values: number[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      labels.push(ds.slice(5).replace('-', '/'));
      values.push(dataMap.get(ds) ?? 0);
    }

    const onSurfaceVariant = this.resolveColor('--mat-sys-on-surface-variant', 'rgba(128,128,128,0.9)');
    const outlineVariant   = this.resolveColor('--mat-sys-outline-variant', 'rgba(128,128,128,0.2)');

    this.chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Net words',
          data: values,
          backgroundColor: values.map(v => v >= 0 ? 'rgba(79,177,128,0.8)' : 'rgba(229,115,115,0.8)'),
          borderColor:     values.map(v => v >= 0 ? 'rgba(79,177,128,1)'   : 'rgba(229,115,115,1)'),
          borderWidth: 1,
          borderRadius: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y as number;
                return `${v >= 0 ? '+' : ''}${v.toLocaleString()} words`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: onSurfaceVariant,
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 10,
              font: { size: 10 },
            },
            grid: { color: outlineVariant },
          },
          y: {
            ticks: {
              color: onSurfaceVariant,
              callback: v => Number(v).toLocaleString(),
              font: { size: 10 },
            },
            grid: { color: outlineVariant },
          },
        },
      },
    });
  }
}
