import { TestBed } from '@angular/core/testing';

import { Ors } from './ors';

describe('Ors', () => {
  let service: Ors;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Ors);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
