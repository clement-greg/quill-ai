import {
  Component, inject, signal, computed,
  ViewChild, ElementRef, effect, NgZone,
  AfterViewInit, OnDestroy, ChangeDetectionStrategy, OnInit,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
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

interface ChapterDayStat {
  chapterId: string;
  title: string;
  thumbnailUrl: string | null;
  wordsAdded: number;
  wordsDeleted: number;
  netWords: number;
}

interface DailyStats {
  date: string;
  wordsAdded: number;
  wordsDeleted: number;
  chapters: ChapterDayStat[];
}

interface ChapterStats {
  chapterId: string;
  title: string;
  thumbnailUrl: string | null;
  wordsAdded: number;
  wordsDeleted: number;
  netWords: number;
  lastSaved: string;
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

interface PeriodBucket {
  label: string;
  net: number;
  dates: string[];
}

interface DayBreakdown {
  title: string;
  net: number;
  chapters: ChapterDayStat[];
  x: number;
  y: number;
  below: boolean;
}

interface CalDay {
  date: string;
  n: number;
  disabled: boolean;
  pad: boolean;
}

function formatBestDayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

@Component({
  selector: 'app-writing-stats',
  imports: [DecimalPipe, RouterLink, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'writing-stats-host',
    '(document:keydown.escape)': 'selectedDay.set(null)',
    '(window:resize)': 'selectedDay.set(null)',
  },
  template: `
    <div class="stats-page">
      <h2 class="page-title">Writing Stats</h2>

      <div class="range-controls">
        <div class="range-row" role="group" aria-label="Time range">
          <button mat-stroked-button [class.active]="activeMode() === '30'" (click)="setPreset(30)">30 days</button>
          <button mat-stroked-button [class.active]="activeMode() === '90'" (click)="setPreset(90)">90 days</button>
          <button mat-stroked-button [class.active]="activeMode() === 'custom'" (click)="openPicker()">
            <mat-icon>date_range</mat-icon>
            {{ customRangeLabel() }}
          </button>
        </div>

        @if (showPicker()) {
          <div class="rp-backdrop" (click)="cancelPicker()" aria-hidden="true"></div>
          <div class="range-picker" role="region" aria-label="Select date range">
          <div class="rp-header">
            <button mat-icon-button [disabled]="!canGoPrev()" (click)="pickerPrevMonth()" aria-label="Previous month">
              <mat-icon>chevron_left</mat-icon>
            </button>
            <div class="rp-month-titles">
              <span class="rp-month-title">{{ pickerLeftLabel() }}</span>
              <span class="rp-month-title rp-right-title">{{ pickerRightLabel() }}</span>
            </div>
            <button mat-icon-button [disabled]="!canGoNext()" (click)="pickerNextMonth()" aria-label="Next month">
              <mat-icon>chevron_right</mat-icon>
            </button>
          </div>

          <div class="rp-calendars" (mouseleave)="hoverDate.set(null)">
            <div class="rp-calendar" role="grid" [attr.aria-label]="pickerLeftLabel()">
              <div class="rp-weekdays" aria-hidden="true">
                @for (d of weekdays; track d) { <span>{{ d }}</span> }
              </div>
              <div class="rp-grid">
                @for (day of leftMonthDays(); track $index) {
                  @if (day.pad) {
                    <span class="rp-cell" aria-hidden="true"></span>
                  } @else {
                    <span [class]="cellClass(day.date)">
                      <button
                        [class]="btnClass(day.date, day.disabled)"
                        [disabled]="day.disabled"
                        (click)="onDayClick(day.date)"
                        (mouseenter)="hoverDate.set(day.date)"
                        [attr.aria-label]="day.date"
                        [attr.aria-pressed]="isSelected(day.date) ? true : null"
                        role="gridcell">{{ day.n }}</button>
                    </span>
                  }
                }
              </div>
            </div>

            <div class="rp-calendar rp-right-calendar" role="grid" [attr.aria-label]="pickerRightLabel()">
              <div class="rp-weekdays" aria-hidden="true">
                @for (d of weekdays; track d) { <span>{{ d }}</span> }
              </div>
              <div class="rp-grid">
                @for (day of rightMonthDays(); track $index) {
                  @if (day.pad) {
                    <span class="rp-cell" aria-hidden="true"></span>
                  } @else {
                    <span [class]="cellClass(day.date)">
                      <button
                        [class]="btnClass(day.date, day.disabled)"
                        [disabled]="day.disabled"
                        (click)="onDayClick(day.date)"
                        (mouseenter)="hoverDate.set(day.date)"
                        [attr.aria-label]="day.date"
                        [attr.aria-pressed]="isSelected(day.date) ? true : null"
                        role="gridcell">{{ day.n }}</button>
                    </span>
                  }
                }
              </div>
            </div>
          </div>

          <div class="rp-footer">
            <span class="rp-hint">{{ selectionHint() }}</span>
            <div class="rp-actions">
              <button mat-button (click)="cancelPicker()">Cancel</button>
              <button mat-flat-button [disabled]="!pendingStart() || !pendingEnd()" (click)="applyPicker()">Apply</button>
            </div>
          </div>
        </div>
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
          <div class="stat-card streak">
            <mat-icon aria-hidden="true">local_fire_department</mat-icon>
            <span class="stat-value">{{ allData()?.summary?.currentStreak ?? 0 }}</span>
            <span class="stat-label">Day Streak</span>
          </div>
          <div class="stat-card best-day">
            <mat-icon aria-hidden="true">emoji_events</mat-icon>
            @if (summary().bestDay) {
              <span class="stat-value">{{ summary().bestDay!.words | number }}</span>
              <span class="stat-label">Best Day · {{ formatBestDayDate(summary().bestDay!.date) }}</span>
            } @else {
              <span class="stat-value">—</span>
              <span class="stat-label">Best Day</span>
            }
          </div>
        </div>

        <div class="chart-section">
          <div class="chart-wrap">
            <canvas #chartCanvas
                    [attr.aria-label]="'Net words written per ' + chartGranularity() + '. Select a bar for a chapter breakdown.'"
                    role="img"></canvas>

            @if (selectedDay(); as sel) {
              <div class="db-backdrop" (click)="selectedDay.set(null)" aria-hidden="true"></div>
              <div class="db-popover"
                   [class.below]="sel.below"
                   [style.left.px]="sel.x"
                   [style.top.px]="sel.y"
                   role="dialog"
                   aria-label="Chapter breakdown for selected period">
                <div class="db-header">
                  <div class="db-titles">
                    <h3 class="db-title">{{ sel.title }}</h3>
                    <span class="db-net" [class.negative]="sel.net < 0">
                      {{ sel.net >= 0 ? '+' : '' }}{{ sel.net | number }} net words
                    </span>
                  </div>
                  <button mat-icon-button class="db-close" (click)="selectedDay.set(null)" aria-label="Close breakdown">
                    <mat-icon>close</mat-icon>
                  </button>
                </div>
                @if (sel.chapters.length) {
                  <div class="db-list">
                    @for (c of sel.chapters; track c.chapterId) {
                      <div class="db-row">
                        <span class="db-thumb">
                          @if (c.thumbnailUrl) {
                            <img [src]="c.thumbnailUrl" [alt]="c.title" class="db-thumb-img" />
                          } @else {
                            <span class="db-thumb-placeholder" aria-hidden="true">
                              <mat-icon>menu_book</mat-icon>
                            </span>
                          }
                        </span>
                        <a [routerLink]="['/chapters', c.chapterId, 'edit']" class="db-link" [title]="c.title">{{ c.title }}</a>
                        <div class="db-stats">
                          <span class="db-added">{{ fmtCount(c.wordsAdded, '+') }}</span>
                          <span class="db-deleted">{{ fmtCount(c.wordsDeleted, '−') }}</span>
                          <span class="db-rownet"
                                [class.positive]="c.netWords > 0"
                                [class.negative]="c.netWords < 0">
                            {{ fmtCount(c.netWords, c.netWords >= 0 ? '+' : '') }}
                          </span>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="db-empty">No chapter activity recorded for this {{ chartGranularity() }}.</p>
                }
              </div>
            }
          </div>
          <p class="chart-hint">Select a bar to see which chapters were worked on that {{ chartGranularity() }}.</p>
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
                  <span class="ch-title" role="cell" [title]="ch.title">
                    <a [routerLink]="['/chapters', ch.chapterId, 'edit']" class="ch-link">{{ ch.title }}</a>
                  </span>
                  <div class="ch-stats" role="presentation">
                    <span class="ch-added" role="cell">{{ fmtCount(ch.wordsAdded, '+') }}</span>
                    <span class="ch-deleted" role="cell">{{ fmtCount(ch.wordsDeleted, '−') }}</span>
                    <span class="ch-net" role="cell"
                          [class.positive]="ch.netWords > 0"
                          [class.negative]="ch.netWords < 0">
                      {{ fmtCount(ch.netWords, ch.netWords >= 0 ? '+' : '') }}
                    </span>
                    <span class="ch-date" role="cell">{{ ch.lastSaved }}</span>
                  </div>
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

    /* ── Range row ──────────────────────────────────────── */

    .range-controls {
      position: relative;
      margin-bottom: 28px;
    }

    .range-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;

      button.active {
        background: var(--mat-sys-primary-container);
        color: var(--mat-sys-on-primary-container);
        border-color: var(--mat-sys-primary);
      }

      mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
        margin-right: 4px;
        vertical-align: middle;
      }
    }

    /* ── Date range picker popover ──────────────────────── */

    .rp-backdrop {
      position: fixed;
      inset: 0;
      z-index: 99;
    }

    .range-picker {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 100;
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 16px;
      padding: 16px 20px 18px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);

      @media (max-width: 600px) {
        left: 0;
        right: 0;
      }
    }

    .rp-header {
      display: flex;
      align-items: center;
      margin-bottom: 10px;
    }

    .rp-month-titles {
      flex: 1;
      display: flex;
      justify-content: space-around;
    }

    .rp-month-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface);
      text-align: center;
      width: 252px;
    }

    .rp-right-title {
      @media (max-width: 600px) { display: none; }
    }

    .rp-calendars {
      display: flex;
      gap: 24px;
      user-select: none;
    }

    .rp-right-calendar {
      @media (max-width: 600px) { display: none; }
    }

    .rp-weekdays {
      display: grid;
      grid-template-columns: repeat(7, 36px);
      margin-bottom: 2px;

      span {
        width: 36px;
        text-align: center;
        font-size: 0.68rem;
        font-weight: 600;
        color: var(--mat-sys-on-surface-variant);
        padding: 2px 0 6px;
      }
    }

    .rp-grid {
      display: grid;
      grid-template-columns: repeat(7, 36px);
    }

    /* Cell wrapper handles the range-band background */
    .rp-cell {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;

      &.rp-between {
        background: var(--mat-sys-primary-container);
      }
      &.rp-start-cell {
        background: linear-gradient(to right, transparent 50%, var(--mat-sys-primary-container) 50%);
      }
      &.rp-end-cell {
        background: linear-gradient(to left, transparent 50%, var(--mat-sys-primary-container) 50%);
      }
    }

    /* Day button renders the circle */
    .rp-btn {
      width: 34px;
      height: 34px;
      flex-shrink: 0;
      border: none;
      background: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      transition: background 100ms;
      line-height: 1;
      font-family: inherit;

      &:hover:not(:disabled) {
        background: var(--mat-sys-surface-container-highest);
      }

      &.rp-selected {
        background: var(--mat-sys-primary);
        color: var(--mat-sys-on-primary);
      }

      &.rp-today:not(.rp-selected)::after {
        content: '';
        position: absolute;
        bottom: 3px;
        left: 50%;
        transform: translateX(-50%);
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--mat-sys-primary);
      }

      &.rp-disabled, &:disabled {
        color: var(--mat-sys-on-surface-variant);
        opacity: 0.35;
        cursor: default;
        pointer-events: none;
      }
    }

    .rp-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--mat-sys-outline-variant);
      gap: 16px;
      flex-wrap: wrap;
    }

    .rp-hint {
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
    }

    .rp-actions {
      display: flex;
      gap: 8px;
      margin-left: auto;
    }

    /* ── Spinner / error ────────────────────────────────── */

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

    /* ── Stat cards ─────────────────────────────────────── */

    .stat-cards {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
      margin-bottom: 32px;

      @media (max-width: 640px) {
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

      &.added mat-icon    { color: #4caf50; }
      &.deleted mat-icon  { color: #e57373; }
      &.net mat-icon      { color: var(--mat-sys-secondary); }
      &.streak mat-icon   { color: #ff9800; }
      &.best-day mat-icon { color: #fdd835; }
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

    /* ── Chart ──────────────────────────────────────────── */

    .chart-section {
      background: var(--mat-sys-surface-container-low);
      border-radius: 12px;
      padding: 16px 20px 20px;
    }

    .chart-wrap {
      position: relative;
      height: 280px;
    }

    .chart-hint {
      margin: 10px 0 0;
      text-align: center;
      font-size: 0.75rem;
      color: var(--mat-sys-on-surface-variant);
    }

    /* ── Day breakdown popover ──────────────────────────── */

    .db-backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
    }

    .db-popover {
      position: absolute;
      z-index: 21;
      width: 320px;
      max-width: calc(100% - 8px);
      max-height: 320px;
      overflow-y: auto;
      background: var(--mat-sys-surface-container-high);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
      padding: 10px 14px 12px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
      transform: translate(-50%, calc(-100% - 12px));
      animation: db-pop 120ms ease-out;
    }

    .db-popover.below {
      transform: translate(-50%, 12px);
    }

    /* arrow */
    .db-popover::after {
      content: '';
      position: absolute;
      left: 50%;
      margin-left: -7px;
      border: 7px solid transparent;
      top: 100%;
      border-top-color: var(--mat-sys-surface-container-high);
    }

    .db-popover.below::after {
      top: auto;
      bottom: 100%;
      border-top-color: transparent;
      border-bottom-color: var(--mat-sys-surface-container-high);
    }

    @keyframes db-pop {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .db-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }

    .db-close {
      flex: none;
      margin: -4px -6px 0 0;
    }

    .db-titles {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .db-title {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
      color: var(--mat-sys-on-surface);
    }

    .db-net {
      font-size: 0.85rem;
      font-weight: 500;
      color: #4caf50;
      font-variant-numeric: tabular-nums;

      &.negative { color: #e57373; }
    }

    .db-list {
      display: flex;
      flex-direction: column;
    }

    .db-row {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr) 48px 48px 48px;
      gap: 8px;
      align-items: center;
      padding: 7px 2px;
      font-size: 0.85rem;
      border-bottom: 1px solid var(--mat-sys-outline-variant);

      &:last-child { border-bottom: none; }
      &:hover { background: var(--mat-sys-surface-container); border-radius: 6px; }
    }

    .db-thumb {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .db-thumb-img {
      width: 30px;
      height: 30px;
      border-radius: 4px;
      object-fit: cover;
      display: block;
    }

    .db-thumb-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 4px;
      background: var(--mat-sys-surface-container);

      mat-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
        color: var(--mat-sys-on-surface-variant);
      }
    }

    .db-link {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
      color: var(--mat-sys-primary);
      text-decoration: none;

      &:hover { text-decoration: underline; }
    }

    .db-stats { display: contents; }

    .db-added, .db-deleted, .db-rownet {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .db-added  { color: #4caf50; }
    .db-deleted { color: #e57373; }

    .db-rownet {
      font-weight: 600;
      color: var(--mat-sys-on-surface-variant);
      &.positive { color: #4caf50; }
      &.negative { color: #e57373; }
    }

    .db-empty {
      margin: 4px 0 0;
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
    }

    @media (max-width: 599px) {
      .db-row {
        grid-template-columns: 36px 1fr;
        grid-template-areas: "thumb title" "thumb stats";
        gap: 4px 10px;
        align-items: start;
      }

      .db-thumb { grid-area: thumb; align-self: center; }
      .db-link { grid-area: title; align-self: end; }

      .db-stats {
        display: flex;
        grid-area: stats;
        gap: 14px;
      }

      .db-added, .db-deleted, .db-rownet { text-align: left; }
    }

    /* ── Chapter breakdown ──────────────────────────────── */

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
    }

    .ch-stats {
      display: contents;
    }

    @media (max-width: 599px) {
      .chapter-table-head { display: none; }

      .chapter-row {
        display: grid;
        grid-template-columns: 44px 1fr;
        grid-template-areas: "thumb title" "thumb stats";
        gap: 2px 10px;
        padding: 10px 4px;
        align-items: start;
      }

      .ch-thumb { grid-area: thumb; align-self: center; }

      .ch-title {
        grid-area: title;
        align-self: end;
        white-space: normal;
        overflow: visible;
        text-overflow: unset;
      }

      .ch-stats {
        display: flex;
        grid-area: stats;
        gap: 0;
        align-self: start;
        padding-bottom: 2px;
      }

      .ch-added, .ch-deleted, .ch-net {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 2px;
      }

      .ch-added::before  { content: 'Added'; }
      .ch-deleted::before { content: 'Deleted'; }
      .ch-net::before    { content: 'Net'; }

      .ch-added::before, .ch-deleted::before, .ch-net::before {
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--mat-sys-on-surface-variant);
      }

      .ch-date { display: none; }
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

    .ch-link {
      color: var(--mat-sys-primary);
      text-decoration: none;

      &:hover { text-decoration: underline; }
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
  private zone = inject(NgZone);

  @ViewChild('chartCanvas') private chartCanvas!: ElementRef<HTMLCanvasElement>;

  readonly weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  private readonly _today = new Date();
  readonly todayStr = localDateStr(this._today);
  readonly minDateStr = (() => {
    const d = new Date(this._today);
    d.setDate(d.getDate() - 365);
    return localDateStr(d);
  })();

  // ── Main state ───────────────────────────────────────────
  loading = signal(true);
  errorMsg = signal<string | null>(null);
  allData = signal<StatsResponse | null>(null);
  activeMode = signal<'30' | '90' | 'custom'>('30');
  customStart = signal<string | null>(null);
  customEnd = signal<string | null>(null);
  selectedDay = signal<DayBreakdown | null>(null);
  private viewReady = signal(false);

  // ── Picker state ─────────────────────────────────────────
  showPicker = signal(false);
  // Start showing previous month on left, current month on right
  pickerYear = signal(this._today.getMonth() === 0 ? this._today.getFullYear() - 1 : this._today.getFullYear());
  pickerMonth = signal(this._today.getMonth() === 0 ? 11 : this._today.getMonth() - 1);
  pendingStart = signal<string | null>(null);
  pendingEnd = signal<string | null>(null);
  hoverDate = signal<string | null>(null);

  // ── Computed ─────────────────────────────────────────────
  filteredDaily = computed(() => {
    const data = this.allData();
    if (!data) return [];
    const mode = this.activeMode();
    if (mode === 'custom') {
      const s = this.customStart();
      const e = this.customEnd();
      if (!s || !e) return [];
      return data.daily.filter(d => d.date >= s && d.date <= e);
    }
    const cutoff = new Date(this._today);
    cutoff.setDate(cutoff.getDate() - parseInt(mode));
    const cutoffStr = localDateStr(cutoff);
    return data.daily.filter(d => d.date >= cutoffStr);
  });

  readonly formatBestDayDate = formatBestDayDate;

  summary = computed(() => {
    const daily = this.filteredDaily();
    const totalAdded   = daily.reduce((s, d) => s + d.wordsAdded, 0);
    const totalDeleted = daily.reduce((s, d) => s + d.wordsDeleted, 0);
    const bestEntry = daily.reduce<DailyStats | null>((best, d) => {
      const net = d.wordsAdded - d.wordsDeleted;
      return net > 0 && (best === null || net > (best.wordsAdded - best.wordsDeleted)) ? d : best;
    }, null);
    return {
      totalAdded,
      totalDeleted,
      net: totalAdded - totalDeleted,
      activeDays: daily.filter(d => d.wordsAdded > 0 || d.wordsDeleted > 0).length,
      bestDay: bestEntry ? { date: bestEntry.date, words: bestEntry.wordsAdded - bestEntry.wordsDeleted } : null,
    };
  });

  pickerLeftLabel = computed(() =>
    new Date(this.pickerYear(), this.pickerMonth(), 1)
      .toLocaleString('default', { month: 'long', year: 'numeric' })
  );

  pickerRightLabel = computed(() => {
    let m = this.pickerMonth() + 1;
    let y = this.pickerYear();
    if (m > 11) { m = 0; y++; }
    return new Date(y, m, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  });

  leftMonthDays  = computed(() => this.buildMonthDays(this.pickerYear(), this.pickerMonth()));
  rightMonthDays = computed(() => {
    let m = this.pickerMonth() + 1;
    let y = this.pickerYear();
    if (m > 11) { m = 0; y++; }
    return this.buildMonthDays(y, m);
  });

  canGoPrev = computed(() => {
    const minDate = new Date(this._today);
    minDate.setDate(minDate.getDate() - 365);
    return !(this.pickerYear() === minDate.getFullYear() && this.pickerMonth() === minDate.getMonth());
  });

  canGoNext = computed(() => {
    let rm = this.pickerMonth() + 1;
    let ry = this.pickerYear();
    if (rm > 11) { rm = 0; ry++; }
    return !(ry === this._today.getFullYear() && rm === this._today.getMonth());
  });

  customRangeLabel = computed(() => {
    const s = this.customStart();
    const e = this.customEnd();
    return s && e ? `${this.fmtDate(s)} – ${this.fmtDate(e)}` : 'Custom range';
  });

  selectionHint = computed(() => {
    const s = this.pendingStart();
    const e = this.pendingEnd();
    if (!s) return 'Select start date';
    if (!e) return 'Select end date';
    return `${this.fmtDate(s)} – ${this.fmtDate(e)}`;
  });

  chartGranularity = computed(() => {
    if (this.activeMode() !== 'custom') return 'day';
    const s = this.customStart();
    const e = this.customEnd();
    if (!s || !e) return 'day';
    return this.daysBetween(s, e) > 90 ? 'month' : 'day';
  });

  private chart?: Chart;
  private chartBuckets: PeriodBucket[] = [];

  constructor() {
    effect(() => {
      const ready = this.viewReady();
      const _data = this.filteredDaily();
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

  // ── Range controls ───────────────────────────────────────

  setPreset(days: 30 | 90): void {
    this.showPicker.set(false);
    this.selectedDay.set(null);
    this.activeMode.set(String(days) as '30' | '90');
  }

  openPicker(): void {
    const s = this.customStart();
    const e = this.customEnd();
    if (s && e) {
      this.pendingStart.set(s);
      this.pendingEnd.set(e);
      // Navigate left calendar to the start month
      const parts = s.split('-').map(Number);
      this.pickerYear.set(parts[0]);
      this.pickerMonth.set(parts[1] - 1);
    } else {
      this.pendingStart.set(null);
      this.pendingEnd.set(null);
    }
    this.hoverDate.set(null);
    this.showPicker.set(true);
  }

  cancelPicker(): void {
    this.showPicker.set(false);
  }

  applyPicker(): void {
    const s = this.pendingStart();
    const e = this.pendingEnd();
    if (!s || !e) return;
    const [start, end] = s <= e ? [s, e] : [e, s];
    this.selectedDay.set(null);
    this.customStart.set(start);
    this.customEnd.set(end);
    this.activeMode.set('custom');
    this.showPicker.set(false);
  }

  pickerPrevMonth(): void {
    let m = this.pickerMonth() - 1;
    let y = this.pickerYear();
    if (m < 0) { m = 11; y--; }
    this.pickerMonth.set(m);
    this.pickerYear.set(y);
  }

  pickerNextMonth(): void {
    let m = this.pickerMonth() + 1;
    let y = this.pickerYear();
    if (m > 11) { m = 0; y++; }
    this.pickerMonth.set(m);
    this.pickerYear.set(y);
  }

  onDayClick(date: string): void {
    const s = this.pendingStart();
    const e = this.pendingEnd();
    if (!s || (s && e)) {
      this.pendingStart.set(date);
      this.pendingEnd.set(null);
    } else {
      this.pendingEnd.set(date);
    }
  }

  // ── Day cell helpers (read signals → tracked by Angular) ─

  isSelected(date: string): boolean {
    const [rs, re] = this.effectiveRange();
    return date === rs || date === re;
  }

  cellClass(date: string): string {
    const [rs, re] = this.effectiveRange();
    if (!rs || !re) return 'rp-cell';
    if (date === rs && date !== re) return 'rp-cell rp-start-cell';
    if (date === re && date !== rs) return 'rp-cell rp-end-cell';
    if (date > rs && date < re) return 'rp-cell rp-between';
    return 'rp-cell';
  }

  btnClass(date: string, disabled: boolean): string {
    const [rs, re] = this.effectiveRange();
    const selected = date === rs || date === re;
    const today = date === this.todayStr;
    return [
      'rp-btn',
      selected ? 'rp-selected' : '',
      today    ? 'rp-today'    : '',
      disabled ? 'rp-disabled' : '',
    ].filter(Boolean).join(' ');
  }

  // ── Formatters ───────────────────────────────────────────

  fmtCount(n: number, prefix = ''): string {
    return n === 0 ? '—' : `${prefix}${n.toLocaleString()}`;
  }

  private fmtDate(ds: string): string {
    const [y, m, d] = ds.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('default', { month: 'short', day: 'numeric' });
  }

  // ── Picker internals ─────────────────────────────────────

  private effectiveRange(): [string | null, string | null] {
    const s = this.pendingStart();
    const e = this.pendingEnd();
    const h = this.hoverDate();
    if (!s) return [null, null];
    const end = e ?? h;
    if (!end) return [s, null];
    return s <= end ? [s, end] : [end, s];
  }

  private buildMonthDays(year: number, month: number): CalDay[] {
    const firstWeekday = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    const days: CalDay[] = [];
    for (let i = 0; i < firstWeekday; i++) {
      days.push({ date: '', n: 0, disabled: true, pad: true });
    }
    for (let d = 1; d <= lastDate; d++) {
      const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({
        date: ds,
        n: d,
        disabled: ds > this.todayStr || ds < this.minDateStr,
        pad: false,
      });
    }
    return days;
  }

  // ── Data loading ─────────────────────────────────────────

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

  // ── Chart ────────────────────────────────────────────────

  private getChartBuckets(): PeriodBucket[] {
    const mode = this.activeMode();
    const daily = this.filteredDaily();
    const netMap = new Map(daily.map(d => [d.date, d.wordsAdded - d.wordsDeleted]));

    if (mode === 'custom') {
      const start = this.customStart()!;
      const end   = this.customEnd()!;
      const span  = this.daysBetween(start, end);

      if (span > 90) {
        return this.monthlyBuckets(daily, start, end);
      }

      // Daily buckets for the exact selected range
      const buckets: PeriodBucket[] = [];
      const cur = new Date(start + 'T00:00:00');
      const endDate = new Date(end + 'T00:00:00');
      while (cur <= endDate) {
        const ds = localDateStr(cur);
        buckets.push({ label: ds.slice(5).replace('-', '/'), net: netMap.get(ds) ?? 0, dates: [ds] });
        cur.setDate(cur.getDate() + 1);
      }
      return buckets;
    }

    // Preset: zero-filled daily window
    const days = parseInt(mode) as 30 | 90;
    const buckets: PeriodBucket[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(this._today);
      d.setDate(d.getDate() - i);
      const ds = localDateStr(d);
      buckets.push({ label: ds.slice(5).replace('-', '/'), net: netMap.get(ds) ?? 0, dates: [ds] });
    }
    return buckets;
  }

  private monthlyBuckets(daily: DailyStats[], start: string, end: string): PeriodBucket[] {
    const monthMap = new Map<string, number>();
    const monthDates = new Map<string, string[]>();
    for (const d of daily) {
      const key = d.date.slice(0, 7);
      monthMap.set(key, (monthMap.get(key) ?? 0) + (d.wordsAdded - d.wordsDeleted));
      if (!monthDates.has(key)) monthDates.set(key, []);
      monthDates.get(key)!.push(d.date);
    }
    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    const buckets: PeriodBucket[] = [];
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      buckets.push({
        label: new Date(y, m - 1, 1).toLocaleString('default', { month: 'short' }) + ' \'' + String(y).slice(2),
        net: monthMap.get(key) ?? 0,
        dates: monthDates.get(key) ?? [],
      });
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return buckets;
  }

  // ── Day/period breakdown ─────────────────────────────────

  // Approx popover width — used to keep it inside the chart on the x-axis
  private readonly POPOVER_W = 320;

  private selectBucket(idx: number, barX: number, barY: number, wrapW: number): void {
    const bucket = this.chartBuckets[idx];
    if (!bucket) { this.selectedDay.set(null); return; }

    const dayByDate = new Map(this.filteredDaily().map(d => [d.date, d]));
    const agg = new Map<string, ChapterDayStat>();
    for (const date of bucket.dates) {
      const day = dayByDate.get(date);
      if (!day) continue;
      for (const c of day.chapters) {
        const existing = agg.get(c.chapterId);
        if (existing) {
          existing.wordsAdded += c.wordsAdded;
          existing.wordsDeleted += c.wordsDeleted;
          existing.netWords = existing.wordsAdded - existing.wordsDeleted;
        } else {
          agg.set(c.chapterId, { ...c });
        }
      }
    }
    const chapters = [...agg.values()]
      .sort((a, b) => (b.wordsAdded + b.wordsDeleted) - (a.wordsAdded + a.wordsDeleted));
    const net = chapters.reduce((s, c) => s + c.netWords, 0);

    // Anchor the popover above the bar by default; flip below if the bar is
    // near the top of the chart. Clamp x so the popover stays inside the chart.
    const half = Math.min(this.POPOVER_W, wrapW - 8) / 2;
    const x = Math.max(half + 4, Math.min(wrapW - half - 4, barX));
    const below = barY < 180;

    this.selectedDay.set({ title: this.bucketTitle(bucket), net, chapters, x, y: barY, below });
  }

  private bucketTitle(bucket: PeriodBucket): string {
    if (this.chartGranularity() === 'day' && bucket.dates.length === 1) {
      const [y, m, d] = bucket.dates[0].split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });
    }
    return bucket.label;
  }

  private daysBetween(start: string, end: string): number {
    return Math.round(
      (new Date(end + 'T00:00:00').getTime() - new Date(start + 'T00:00:00').getTime()) / 86400000
    );
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
    this.chartBuckets = buckets;
    const onSurfaceVariant = this.resolveColor('--mat-sys-on-surface-variant', 'rgba(128,128,128,0.9)');
    const outlineVariant   = this.resolveColor('--mat-sys-outline-variant', 'rgba(128,128,128,0.25)');

    this.chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [{
          label: 'Net words',
          data: buckets.map(b => b.net),
          backgroundColor: buckets.map(b => b.net >= 0 ? 'rgba(79,177,128,0.8)' : 'rgba(229,115,115,0.8)'),
          borderColor:     buckets.map(b => b.net >= 0 ? 'rgba(79,177,128,1)'   : 'rgba(229,115,115,1)'),
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_evt, elements, chart) => {
          if (!elements.length) return;
          const { index, element } = elements[0];
          const barX = element.x;
          const barY = element.y;
          const wrapW = chart.width;
          this.zone.run(() => this.selectBucket(index, barX, barY, wrapW));
        },
        onHover: (evt, elements) => {
          const target = evt.native?.target as HTMLElement | undefined;
          if (target) target.style.cursor = elements.length ? 'pointer' : 'default';
        },
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
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: Math.min(buckets.length, 15),
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
