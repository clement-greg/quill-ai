import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SaUsersService } from './sa-users.service';

describe('SaUsersService', () => {
  let service: SaUsersService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(SaUsersService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('loads SA emails and known users', async () => {
    const load = service.load();
    httpMock.expectOne('/api/sa/users').flush({ emails: ['a@x.com'], knownUsers: [{ email: 'b@x.com' }] });
    await load;
    expect(service.emails()).toEqual(['a@x.com']);
    expect(service.knownUsers()).toEqual([{ email: 'b@x.com' }]);
  });

  it('grants access', async () => {
    const grant = service.grant('b@x.com');
    const req = httpMock.expectOne('/api/sa/users');
    expect(req.request.body).toEqual({ email: 'b@x.com' });
    req.flush({ emails: ['a@x.com', 'b@x.com'], knownUsers: [] });
    expect(await grant).toBeNull();
    expect(service.emails()).toEqual(['a@x.com', 'b@x.com']);
  });

  it("passes on the server's reason when removal is refused", async () => {
    const revoke = service.revoke('a@x.com');
    httpMock.expectOne('/api/sa/users/a%40x.com')
      .flush({ error: "You can't remove your own SA access" }, { status: 400, statusText: 'Bad Request' });
    expect(await revoke).toBe("You can't remove your own SA access");
  });
});
