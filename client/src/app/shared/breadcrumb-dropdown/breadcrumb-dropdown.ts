import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatMenuModule } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { BreadcrumbItem } from '@app/core/services/header.service';

@Component({
  selector: 'app-breadcrumb-dropdown',
  standalone: true,
  imports: [RouterLink, MatMenuModule, MatIconModule],
  templateUrl: './breadcrumb-dropdown.html',
  styleUrl: './breadcrumb-dropdown.scss',
})
export class BreadcrumbDropdownComponent {
  crumb = input.required<BreadcrumbItem>();
}
