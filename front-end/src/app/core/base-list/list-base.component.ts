import { AfterViewInit, Directive, EventEmitter, OnDestroy, ViewChild } from '@angular/core';
import { MatPaginator, PageEvent } from '@angular/material/paginator';
import { MatSort, MatSortHeader } from '@angular/material/sort';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { AppConfig } from '@core/app.config';
import { ListRequest } from '@core/models/common/ListRequest';
import { BaseApiService } from '@core/services/base-api.service';
import { nameOf } from '@utils/nameof';
import { filter as arrFilter, get, isEqual, isNil, omitBy } from 'lodash-es';
import { merge, Subscription } from 'rxjs';
import { distinctUntilChanged, map, tap } from 'rxjs/operators';
import { PaginatedDataSource } from './paginated-datasource';

// Basic version of generic list.
/*
	Checklist for testing derived classes:
		- Changing the current page fetches the right chunk of records applying all the filters and the sorting order;
		- Sorting by columns:
			- Resets the page index;
			- Brings records in the expected order;
		- Applying filters from the filter bar:
			- Resets the page index;
			- Brings expected records;
			- If search text, then the order is reset;
		- Navigating to a filtered page in different ways:
			- Opening the page with the URL containing filters in the query string;
			- Internal navigation between the pages;
			- The browser's backward/forward button
 */
@Directive()
export abstract class ListBaseComponent<TListItemDto, TFilter extends ListRequest> implements AfterViewInit, OnDestroy {
	@ViewChild(MatPaginator)
	paginator!: MatPaginator;
	@ViewChild(MatSort)
	sort!: MatSort;

	// The filter for the filtering bar (not including `ListRequest` properties)
	filter$: Observable<Partial<TFilter>>;

	// Displayed columns. Override this property if you need conditional hiding of some columns
	get displayedColumns(): string[] {
		return this.defaultDisplayedColumns;
	}
	get pageSizeOptions(): number[] {
		return AppConfig.PageSizeOptions;
	}
	pageSize: number = AppConfig.PageSize;

	get dataSource(): PaginatedDataSource<TListItemDto, TFilter> {
		return this._dataSource;
	}
	private _dataSource: PaginatedDataSource<TListItemDto, TFilter>;

	protected subscriptions = new Subscription();

	// This is used for requested page (from URL) only, bind to the value from the response in the UI
	private _pageIndex: number = 0;
	private _requests = new EventEmitter<TFilter>();

	constructor(
		protected router: Router,
		protected activatedRoute: ActivatedRoute,
		/* The service for requesting the list from API */
		protected service: BaseApiService,
		/* Default visible columns */
		protected defaultDisplayedColumns: string[],
		/* Default filtering conditions (e.g. default sorting order) */
		private _defaultFilter: Partial<TFilter>
	) {
		this._dataSource = new PaginatedDataSource<TListItemDto, TFilter>(this.service, this._requests);

		// Initialise the Page Index/Size and Sorting from the QueryString
		this.filter$ = this.activatedRoute.queryParamMap.pipe(
			// Convert Query String parameters to TFilter instance
			map(params => this.getFilterFromQueryString(params)),
			// Initiate a request to fetch data
			tap(f => this._requests.emit(f)),
			// Set page number and sorting order on the table
			tap(f => {
				console.debug('activatedRoute: ' + JSON.stringify(f));

				this._pageIndex = +(f?.pageIndex || 0); // +(params.get(nameOf<ListRequest>('pageIndex')) || 0);
				this.pageSize = +(f?.pageSize || AppConfig.PageSize); //+(params.get(nameOf<ListRequest>('pageSize')) || AppConfig.PageSize);

				// Set grid Sorting
				//this.setSort(f);
			}),
			map(f => {
				// Remove the common list properties from the rest of the filters
				[
					nameOf<ListRequest>('pageIndex'),
					nameOf<ListRequest>('pageSize'),
					nameOf<ListRequest>('orderBy'),
					nameOf<ListRequest>('orderDirection'),
				].forEach(prop => {
					delete f[prop];
				});
				// Set the sanitized filter for use in the custom filter bar of the list
				return omitBy(f, isNil) as Partial<TFilter>;
			})
		);
	}

	// Subscribe for filter triggers after the nested components get initialised (must be AfterViewInit, instead of ngOnInit).
	// If we were using 'BehaviorSubject' for 'triggers', then the current value'd have been emitted in the subscriber,
	// but we're using 'EventEmitter', so we expect that 'DataSource.connect()' is called and have subscribed for events
	ngAfterViewInit() {
		// List of all triggers, which can cause refreshing data in the grid
		// Reset back to the first page if we change filters (anything, except the page number)
		const triggers = [
			this.paginator.page.pipe(
				tap((page: PageEvent) => {
					console.debug('TRIGGER: page event');
					if (!!page) {
						this._pageIndex = page.pageSize !== this.pageSize ? 0 : page.pageIndex;
						this.pageSize = page.pageSize;
					}
				})
			),
			this.sort.sortChange.pipe(
				distinctUntilChanged(),
				tap(() => {
					console.debug('TRIGGER: sorting');
					this._pageIndex = 0;
				})
			),
			this.filter$.pipe(
				tap(f => console.debug('TRIGGER: filter. ' + JSON.stringify(f))),
				tap(() => (this._pageIndex = 0))
			),
		];

		this.subscriptions.add(
			merge(...arrFilter(triggers, Boolean))
				.pipe(distinctUntilChanged(isEqual))
				.subscribe(() => {
					// Get merged filter from all the Query Parameters
					const accruedFilter = this.mergeFilters({} as TFilter);
					console.debug('NAVIGATE: ' + JSON.stringify(accruedFilter));
					// Update the QueryString
					this.router.navigate([], {
						queryParams: accruedFilter,
						relativeTo: this.activatedRoute,
					});
				})
		);
	}

	ngOnDestroy() {
		this.subscriptions.unsubscribe();
	}

	isColumnVisible(columnName: string): boolean {
		return this.displayedColumns.indexOf(columnName) !== -1;
	}

	protected refreshList(filter: TFilter): void {
		const userFilter = this.mergeFilters(filter);
		// Update the Data Source
		this._requests.emit(userFilter);
	}
	/*
	protected subscribeToEntityCreationNotificationEvent(event: EventEmitter<void>): void {
		this.subscriptions.add(event.subscribe(() => this.refreshList()));
	}*/

	// Build filtering for the list
	protected mergeFilters(filter: TFilter): TFilter {
		const accruedFilter: TFilter = {
			...filter,
			...{
				pageIndex: this._pageIndex,
				pageSize: this.pageSize,
			},
			...(this.sort && this.sort.active ? { orderBy: this.sort.active, orderDirection: this.sort.direction } : {}),
		};
		return accruedFilter;
	}

	// Get an instance of the filter class from Query String parameters
	private getFilterFromQueryString(params: ParamMap): TFilter {
		// convert the ParamMap to an object
		const paramsObj = params.keys.reduce((obj, key) => {
			// 'params.getAll(key)' returns an array, when 'params.get(key)' - only the first value
			let value: string | string[] | null =
				this._defaultFilter[key as keyof TFilter] instanceof Array ? params.getAll(key) : params.get(key);
			if (key.indexOf('[') >= 0) {
				// convert dictionaries to objects
				const [parent, child] = key.split(/\[|\]/);
				value = Object.assign(obj[parent as keyof {}] || {}, { [child]: params.get(key) });
				key = parent;
			}
			return Object.assign(obj, {
				[key]: value,
			});
		}, {});
		return { ...this._defaultFilter, ...paramsObj } as TFilter;
	}

	// Set the indicator of the current sorting on the table.
	private setSort(sortParams: ListRequest): void {
		if (!this.sort) return;
		const disableClear = false;

		//reset state so that start is the first sort direction that you will see
		this.sort.sort({ id: '', start: 'asc', disableClear });

		// If the list shows results of a search, then no sorting order must be applied
		if (!get(sortParams, 'search', null)) return;

		const id: string = sortParams.orderBy || this._defaultFilter.orderBy || '';
		const direction = sortParams.orderDirection || this._defaultFilter.orderDirection;
		const start: 'asc' | 'desc' = direction == 'asc' || direction == 'desc' ? (direction as 'asc' | 'desc') : 'asc';

		this.sort.sort({ id, start, disableClear });

		// It's a workaround of a Material bug. See more at https://github.com/angular/components/issues/10242#issuecomment-535457992
		if (!!this.sort.active) {
			(this.sort.sortables.get(id) as MatSortHeader)._setAnimationTransitionState({ toState: 'active' });
		}
	}
}
