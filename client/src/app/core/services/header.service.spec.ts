import { TestBed } from '@angular/core/testing';
import { HeaderService, BreadcrumbItem, HeaderMenuAction } from './header.service';

const seriesCrumb: BreadcrumbItem = { label: 'Dune Saga', link: '/series/s-1' };
const bookCrumb: BreadcrumbItem = { label: 'Dune', link: '/books/b-1' };

function action(label: string): HeaderMenuAction {
  return { icon: 'edit', label, action: () => void 0 };
}

describe('HeaderService', () => {
  let service: HeaderService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(HeaderService);
  });

  it('starts with no breadcrumbs and no actions', () => {
    expect(service.breadcrumbs()).toEqual([]);
    expect(service.menuActions()).toEqual([]);
  });

  it('setContext shows the context crumbs and actions', () => {
    service.setContext([seriesCrumb, bookCrumb], [action('Rename')]);
    expect(service.breadcrumbs()).toEqual([seriesCrumb, bookCrumb]);
    expect(service.menuActions().map(a => a.label)).toEqual(['Rename']);
  });

  it('setPage appends a flat page label after the persisted context', () => {
    service.setContext([seriesCrumb]);
    service.setPage('Settings');
    expect(service.breadcrumbs().map(c => c.label)).toEqual(['Dune Saga', 'Settings']);
  });

  it('setPage replaces a previous page label instead of stacking', () => {
    service.setContext([seriesCrumb]);
    service.setPage('Settings');
    service.setPage('Archived');
    expect(service.breadcrumbs().map(c => c.label)).toEqual(['Dune Saga', 'Archived']);
  });

  it('setContext clears any stale page label', () => {
    service.setPage('Settings');
    service.setContext([seriesCrumb]);
    expect(service.breadcrumbs()).toEqual([seriesCrumb]);
  });

  it('setPage replaces actions without touching context crumbs', () => {
    service.setContext([seriesCrumb], [action('Rename')]);
    service.setPage('Settings', [action('Reset')]);
    expect(service.breadcrumbs().map(c => c.label)).toEqual(['Dune Saga', 'Settings']);
    expect(service.menuActions().map(a => a.label)).toEqual(['Reset']);
  });

  it('set is an alias for setContext', () => {
    service.set([seriesCrumb, bookCrumb], [action('Delete')]);
    expect(service.breadcrumbs()).toEqual([seriesCrumb, bookCrumb]);
    expect(service.menuActions().map(a => a.label)).toEqual(['Delete']);
  });

  it('clear removes the page label and actions but preserves context', () => {
    service.setContext([seriesCrumb], [action('Rename')]);
    service.setPage('Settings', [action('Reset')]);
    service.clear();
    expect(service.breadcrumbs()).toEqual([seriesCrumb]);
    expect(service.menuActions()).toEqual([]);
  });

  it('clearAll removes everything including context', () => {
    service.setContext([seriesCrumb, bookCrumb], [action('Rename')]);
    service.setPage('Settings');
    service.clearAll();
    expect(service.breadcrumbs()).toEqual([]);
    expect(service.menuActions()).toEqual([]);
  });
});
