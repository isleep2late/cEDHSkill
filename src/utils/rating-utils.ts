export class RatingUtils {
    /**
     * Calculates the ordinal value from mu and sigma.
     * Ordinal is typically mu - 3 * sigma.
     * @param mu The mean of the rating.
     * @param sigma The standard deviation of the rating.
     * @returns The ordinal value.
     */
    public static calculateOrdinal(mu: number, sigma: number): number {
        return mu - 3 * sigma;
    }

    /**
     * Calculates the Elo rating based on mu and sigma.
     * Elo = (ordinal + 20) * 58.33
     * @param mu The mean of the rating.
     * @param sigma The standard deviation of the rating.
     * @returns The Elo rating, rounded to the nearest integer.
     */
    public static calculateElo(mu: number, sigma: number): number {
        const ordinal = this.calculateOrdinal(mu, sigma);
        return Math.round((ordinal + 20) * 58.33);
    }
}