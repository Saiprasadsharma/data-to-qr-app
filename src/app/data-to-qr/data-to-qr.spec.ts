import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DataToQr } from './data-to-qr';

describe('DataToQr', () => {
  let component: DataToQr;
  let fixture: ComponentFixture<DataToQr>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DataToQr],
      providers: [provideZonelessChangeDetection()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DataToQr);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
