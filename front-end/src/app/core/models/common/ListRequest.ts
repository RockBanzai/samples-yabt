import { SortDirection } from '@angular/material/sort';

export class ListRequest {
	orderBy: string = '';
	orderDirection: SortDirection = 'asc';
	pageIndex: number = 0;
	pageSize: number = 0;

	constructor() {}
}
