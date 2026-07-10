import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideEnvironmentInitializer, inject, isDevMode } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, Routes } from '@angular/router';
import { MatIconRegistry } from '@angular/material/icon';
import { provideServiceWorker } from '@angular/service-worker';
import { SeriesComponent } from '@app/features/series/series/series';
import { SeriesDetailComponent } from '@app/features/series/series-detail/series-detail';
import { BookComponent } from '@app/features/books/book/book';
import { BookDetailComponent } from '@app/features/books/book-detail/book-detail';
import { ChapterComponent } from '@app/features/chapters/chapter/chapter';
import { ChapterEditComponent } from '@app/features/chapters/chapter-edit/chapter-edit';
import { EntityRelationshipDiagramComponent } from '@app/features/entities/entity-relationship-diagram/entity-relationship-diagram';
import { LoginComponent } from '@app/features/login/login';
import { ArchivedComponent } from '@app/features/archived/archived';
import { Home } from '@app/features/home/home';
import { UserSettingsComponent } from '@app/features/user-settings/user-settings';
import { PhotoGalleryComponent } from '@app/features/photo-gallery/photo-gallery';
import { WritingStatsComponent } from '@app/features/writing-stats/writing-stats';
import { EntityPageComponent } from '@app/features/entities/entity-page/entity-page';
import { MapListComponent } from '@app/features/maps/map-list/map-list';
import { MapEditorComponent } from '@app/features/maps/map-editor/map-editor';
import { ThoughtsComponent } from '@app/features/thoughts/thoughts';
import { authGuard } from '@app/core/auth/auth.guard';
import { authInterceptor, authErrorInterceptor } from '@app/core/auth/auth.interceptor';

const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'series', component: SeriesComponent, canActivate: [authGuard] },
  { path: 'series/:id', component: SeriesDetailComponent, canActivate: [authGuard] },
  { path: 'books', component: BookComponent, canActivate: [authGuard] },
  { path: 'books/:id', component: BookDetailComponent, canActivate: [authGuard] },
  { path: 'chapters', component: ChapterComponent, canActivate: [authGuard] },
  { path: 'chapters/:id/edit', component: ChapterEditComponent, canActivate: [authGuard] },
  { path: 'series/:seriesId/relationships', component: EntityRelationshipDiagramComponent, canActivate: [authGuard] },
  { path: 'relationships', component: EntityRelationshipDiagramComponent, canActivate: [authGuard] },
  { path: 'archived', component: ArchivedComponent, canActivate: [authGuard] },
  { path: 'settings', component: UserSettingsComponent, canActivate: [authGuard] },
  { path: 'gallery', component: PhotoGalleryComponent, canActivate: [authGuard] },
  { path: 'writing-stats', component: WritingStatsComponent, canActivate: [authGuard] },
  { path: 'entities', component: EntityPageComponent, canActivate: [authGuard] },
  { path: 'entities/:id', component: EntityPageComponent, canActivate: [authGuard] },
  { path: 'series/:seriesId/maps', component: MapListComponent, canActivate: [authGuard] },
  { path: 'maps', component: MapListComponent, canActivate: [authGuard] },
  { path: 'maps/:id', component: MapEditorComponent, canActivate: [authGuard] },
  { path: 'thoughts', component: ThoughtsComponent, canActivate: [authGuard] },
  { path: 'home', component: Home, canActivate: [authGuard] },
  {
    path: 'quilly-demo',
    loadComponent: () =>
      import('@app/features/ai/quilly-demo/quilly-demo').then((m) => m.QuillyDemoComponent),
  },
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  {
    path: '**',
    loadComponent: () =>
      import('@app/features/not-found/not-found').then((m) => m.NotFoundComponent),
  },
];

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([authInterceptor, authErrorInterceptor])),
    provideRouter(routes),
    provideEnvironmentInitializer(() => {
      inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-outlined');
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000'
    }),
  ]
};
