import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, EventEmitter, Input, NgZone, OnInit, Output, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

const RIGHT_PANEL_WIDTH_KEY = 'quill-right-panel-width';
const MIN_RIGHT_PANEL_WIDTH = 280;
const MAX_RIGHT_PANEL_WIDTH = 1000;

@Component({
    selector: 'app-slide-out-panel-container',
    imports: [
        CommonModule,
        MatButtonModule,
        MatIconModule,
    ],
    templateUrl: './slide-out-panel-container.html',
    styleUrl: './slide-out-panel-container.scss',
})
export class SlideOutPanelContainer implements OnInit {

    private readonly zone = inject(NgZone);
    private readonly cdr = inject(ChangeDetectorRef);

    @Input() showRightPanel: boolean = false;
    @Output() showRightPanelChange: EventEmitter<boolean> = new EventEmitter<boolean>();
    @Input() rightPanelWidth: number = 400;
    @Input() rightPanelTop: number = 0;
    @Input() rightCloseButtonTop: number = 8;

    private rightPanelWidthOverride: number | null = null;

    get effectiveRightPanelWidth(): number {
        const raw = this.rightPanelWidthOverride ?? this.rightPanelWidth;
        return Math.min(raw, window.innerWidth);
    }

    ngOnInit(): void {
        const saved = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
        if (saved) {
            const val = parseInt(saved, 10);
            if (!isNaN(val)) this.rightPanelWidthOverride = val;
        }
    }

    onRightResizeStart(event: MouseEvent): void {
        event.preventDefault();
        const panelEl = (event.currentTarget as HTMLElement).parentElement;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';

        this.zone.runOutsideAngular(() => {
            const onMove = (e: MouseEvent) => {
                const newWidth = Math.min(MAX_RIGHT_PANEL_WIDTH, window.innerWidth, Math.max(MIN_RIGHT_PANEL_WIDTH, window.innerWidth - e.clientX));
                this.rightPanelWidthOverride = newWidth;
                if (panelEl) panelEl.style.width = newWidth + 'px';
            };

            const onUp = () => {
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                if (this.rightPanelWidthOverride != null) {
                    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(this.rightPanelWidthOverride));
                }
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this.zone.run(() => this.cdr.detectChanges());
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    @Input() showLeftPanel: boolean = false;
    @Output() showLeftPanelChange: EventEmitter<boolean> = new EventEmitter<boolean>()
    @Input() leftPanelWidth: number = 400;
    @Input() leftPanelTop: number = 0;
    @Input() leftCloseButtonTop: number = 8;

    @Input() showBottomPanel = false;
    @Output() showBottomPanelChange: EventEmitter<boolean> = new EventEmitter<boolean>();
    @Input() bottomPanelHeight: number = 300;
    @Input() bottomPanelWidth: number = 800;

    isScrolled = false;

    closeRightPanel(): void {
        if (this.showRightPanel) {
            this.showRightPanel = false;
            this.showRightPanelChange.emit(this.showRightPanel);
        }
    }

    closeLeftPanel(): void {
        if (this.showLeftPanel) {
            this.showLeftPanel = false;
            this.showLeftPanelChange.emit(this.showLeftPanel);
        }
    }

    closeBottomPanel() {
        if (this.showBottomPanel) {
            this.showBottomPanel = false;
            this.showBottomPanelChange.emit(this.showBottomPanel);
        }
    }

    get rightPanelHeight() {
        return `calc(100vh - ${this.rightPanelTop}px)`;
    }

    trackScroll(event: any) {
        const scrollTop = event.target.scrollTop;
        this.isScrolled = scrollTop > 0;
    }

    get leftPanelHeight() {
        return `calc(100vh - ${this.leftPanelTop}px)`;
    }



}
