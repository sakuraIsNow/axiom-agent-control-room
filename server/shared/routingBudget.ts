/** One server decision includes both Agents and at most one semantic repair. */
export const routingServerBudgetMs = 45_000;
/** Allow the server to finish or report its budget before abandoning the request. */
export const routingClientBudgetMs = routingServerBudgetMs + 5_000;
