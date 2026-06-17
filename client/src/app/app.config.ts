import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideEnvironmentInitializer, inject, isDevMode } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, Routes } from '@angular/router';
import { MatIconRegistry } from '@angular/material/icon';
import { provideServiceWorker } from '@angular/service-worker';
import { SeriesComponent } from './series/series';
import { SeriesDetailComponent } from './series-detail/series-detail';
import { BookComponent } from './book/book';
import { BookDetailComponent } from './book-detail/book-detail';
import { ChapterComponent } from './chapter/chapter';
import { ChapterEditComponent } from './chapter-edit/chapter-edit';
import { EntityRelationshipDiagramComponent } from './entity-relationship-diagram/entity-relationship-diagram';
import { LoginComponent } from './login/login';
import { ArchivedComponent } from './archived/archived';
import { Home } from './home/home';
import { UserSettingsComponent } from './user-settings/user-settings';
import { PhotoGalleryComponent } from './photo-gallery/photo-gallery';
import { WritingStatsComponent } from './writing-stats/writing-stats';
import { EntityPageComponent } from './entity-page/entity-page';
import { MapListComponent } from './maps/map-list/map-list';
import { MapEditorComponent } from './maps/map-editor/map-editor';
import { authGuard } from './auth/auth.guard';
import { authInterceptor } from './auth/auth.interceptor';

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
  { path: 'home', component: Home, canActivate: [authGuard] },
  { path: '', redirectTo: 'home', pathMatch: 'full' },
];

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([authInterceptor])),
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
