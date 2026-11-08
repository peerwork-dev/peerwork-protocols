export class ApiError extends Error {
    code;
    status;
    constructor(code, status, message = code) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
export function requireThat(condition, code, status = 400) {
    if (!condition)
        throw new ApiError(code, status);
}
