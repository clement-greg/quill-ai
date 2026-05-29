import {
  Component, input, effect, ViewChild, ElementRef,
  AfterViewInit, OnDestroy, signal, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Chapter } from '@shared/models/chapter.model';
import { Entity } from '@shared/models/entity.model';
import {
  Chart,
  DoughnutController,
  BarController,
  ArcElement,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js';

Chart.register(
  DoughnutController,
  BarController,
  ArcElement,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
);

export interface ChapterWordStats {
  title: string;
  ai: number;
  modified: number;
  human: number;
  total: number;
}

export interface BookWordStats {
  ai: number;
  modified: number;
  human: number;
  total: number;
  chapters: ChapterWordStats[];
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export interface RepresentationRow {
  label: string;
  entityCount: number;
  mentions: number;
  pct: number;
}

export interface RepresentationStats {
  byGender: RepresentationRow[];
  byRace: RepresentationRow[];
  byOrientation: RepresentationRow[];
  hasData: boolean;
}

function countEntityReferences(chapterHtmls: string[], entityId: string): number {
  let total = 0;
  const div = document.createElement('div');
  for (const html of chapterHtmls) {
    div.innerHTML = html;
    total += div.querySelectorAll(`.entity-reference[data-id="${CSS.escape(entityId)}"]`).length;
  }
  return total;
}

function buildRepresentationRows(
  entities: Entity[],
  chapterHtmls: string[],
  attr: 'gender' | 'race' | 'orientation',
): RepresentationRow[] {
  const groupMap = new Map<string, { entityCount: number; mentions: number }>();

  for (const e of entities) {
    if (e.type !== 'PERSON' || e.isNarrator) continue;
    const key = (e[attr] as string | undefined)?.trim() || 'Not specified';
    const mentions = countEntityReferences(chapterHtmls, e.id);
    const existing = groupMap.get(key) ?? { entityCount: 0, mentions: 0 };
    groupMap.set(key, { entityCount: existing.entityCount + 1, mentions: existing.mentions + mentions });
  }

  if (groupMap.size === 0) return [];

  const maxMentions = Math.max(...[...groupMap.values()].map(v => v.mentions), 1);
  return [...groupMap.entries()]
    .filter(([, v]) => v.mentions > 0)
    .sort((a, b) => b[1].mentions - a[1].mentions)
    .map(([label, v]) => ({
      label,
      entityCount: v.entityCount,
      mentions: v.mentions,
      pct: Math.round((v.mentions / maxMentions) * 100),
    }));
}

function parseChapterStats(html: string): ChapterWordStats {
  const div = document.createElement('div');
  div.innerHTML = html;

  let ai = 0;
  let modified = 0;
  let human = 0;

  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const words = countWords(node.textContent ?? '');
    if (words === 0) continue;
    const span = node.parentElement?.closest<HTMLElement>('[data-ai-generated]');
    if (!span) {
      human += words;
    } else {
      const attr = span.getAttribute('data-ai-generated');
      if (attr === 'modified') {
        modified += words;
      } else {
        ai += words;
      }
    }
  }

  return { title: '', ai, modified, human, total: ai + modified + human };
}

const COLORS = {
  ai: 'rgba(103, 80, 164, 0.85)',
  modified: 'rgba(234, 160, 73, 0.85)',
  human: 'rgba(79, 177, 128, 0.85)',
};

@Component({
  selector: 'app-ai-stats',
  imports: [CommonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './ai-stats.html',
  styleUrl: './ai-stats.scss',
})
export class AiStatsComponent implements AfterViewInit, OnDestroy {
  chapters = input<Chapter[]>([]);
  loading = input<boolean>(false);
  entities = input<Entity[]>([]);

  protected readonly Math = Math;

  @ViewChild('donutCanvas') donutCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('barCanvas') barCanvasRef!: ElementRef<HTMLCanvasElement>;

  private donutChart?: Chart;
  private barChart?: Chart;
  private viewReady = signal(false);

  stats = computed<BookWordStats>(() => {
    const chapters = this.chapters();
    const chapterStats: ChapterWordStats[] = chapters.map(ch => {
      const s = parseChapterStats(ch.content ?? '');
      s.title = ch.title || 'Untitled';
      return s;
    });
    const ai = chapterStats.reduce((s, c) => s + c.ai, 0);
    const modified = chapterStats.reduce((s, c) => s + c.modified, 0);
    const human = chapterStats.reduce((s, c) => s + c.human, 0);
    return { ai, modified, human, total: ai + modified + human, chapters: chapterStats };
  });

  pct(value: number): string {
    const total = this.stats().total;
    if (!total) return '0%';
    return `${Math.round((value / total) * 100)}%`;
  }

  representationStats = computed<RepresentationStats>(() => {
    const chapters = this.chapters();
    const entities = this.entities();
    if (!entities.length || !chapters.length) {
      return { byGender: [], byRace: [], byOrientation: [], hasData: false };
    }
    const chapterHtmls = chapters.map(c => c.content ?? '');
    const byGender = buildRepresentationRows(entities, chapterHtmls, 'gender');
    const byRace = buildRepresentationRows(entities, chapterHtmls, 'race');
    const byOrientation = buildRepresentationRows(entities, chapterHtmls, 'orientation');
    const hasData = byGender.length > 0 || byRace.length > 0 || byOrientation.length > 0;
    return { byGender, byRace, byOrientation, hasData };
  });

  constructor() {
    effect(() => {
      const _chapters = this.chapters();
      const _loading = this.loading();
      const _ready = this.viewReady();
      if (_ready && !_loading) {
        // Defer one tick so Angular can update @ViewChild refs after the
        // @if/@else switch removes the spinner and adds the canvas elements.
        setTimeout(() => this.renderCharts(), 0);
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
  }

  ngOnDestroy(): void {
    this.donutChart?.destroy();
    this.barChart?.destroy();
  }

  private renderCharts(): void {
    this.donutChart?.destroy();
    this.barChart?.destroy();

    const s = this.stats();

    // Material CSS variables use oklch() which the Canvas API can't parse.
    // We resolve them to rgb() by briefly applying the variable to a hidden
    // element and reading the browser-computed value.
    const resolveColor = (cssVar: string, fallback: string): string => {
      const el = document.createElement('div');
      el.style.cssText = `color:var(${cssVar});position:absolute;visibility:hidden`;
      document.body.appendChild(el);
      const resolved = getComputedStyle(el).color;
      document.body.removeChild(el);
      return resolved || fallback;
    };

    const onSurfaceVariant = resolveColor('--mat-sys-on-surface-variant', 'rgba(128,128,128,0.9)');
    const outlineVariant   = resolveColor('--mat-sys-outline-variant',    'rgba(128,128,128,0.25)');
    const surfaceBg        = resolveColor('--mat-sys-surface',             '#fff');

    // Doughnut chart – overall breakdown
    const donutCtx = this.donutCanvasRef?.nativeElement?.getContext('2d');
    if (donutCtx) {
      this.donutChart = new Chart(donutCtx, {
        type: 'doughnut',
        data: {
          labels: ['AI Generated', 'AI + Human', 'Human Written'],
          datasets: [{
            data: [s.ai, s.modified, s.human],
            backgroundColor: [COLORS.ai, COLORS.modified, COLORS.human],
            borderWidth: 2,
            borderColor: surfaceBg,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '62%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: { padding: 16, font: { size: 12 }, color: onSurfaceVariant },
            },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const val = ctx.raw as number;
                  const total = s.total || 1;
                  return ` ${val.toLocaleString()} words (${Math.round((val / total) * 100)}%)`;
                },
              },
            },
          },
        },
      });
    }

    // Stacked horizontal bar chart – per chapter
    const barCtx = this.barCanvasRef?.nativeElement?.getContext('2d');
    if (barCtx && s.chapters.length) {
      const labels = s.chapters.map(c => c.title.length > 22 ? c.title.slice(0, 22) + '…' : c.title);
      this.barChart = new Chart(barCtx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'AI Generated',
              data: s.chapters.map(c => c.ai),
              backgroundColor: COLORS.ai,
              borderRadius: 3,
            },
            {
              label: 'AI + Human',
              data: s.chapters.map(c => c.modified),
              backgroundColor: COLORS.modified,
              borderRadius: 3,
            },
            {
              label: 'Human Written',
              data: s.chapters.map(c => c.human),
              backgroundColor: COLORS.human,
              borderRadius: 3,
            },
          ],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              stacked: true,
              ticks: { font: { size: 11 }, color: onSurfaceVariant },
              grid: { color: outlineVariant },
              title: { display: true, text: 'Words', font: { size: 11 }, color: onSurfaceVariant },
            },
            y: {
              stacked: true,
              ticks: { font: { size: 11 }, color: onSurfaceVariant },
              grid: { display: false },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const val = ctx.raw as number;
                  const ch = s.chapters[ctx.dataIndex];
                  const total = ch.total || 1;
                  return ` ${ctx.dataset.label}: ${val.toLocaleString()} words (${Math.round((val / total) * 100)}%)`;
                },
              },
            },
          },
        },
      });
    }
  }
}
