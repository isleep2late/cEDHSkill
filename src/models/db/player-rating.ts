import { DataTypes, Model, Sequelize, ModelAttributes, ModelStatic } from 'sequelize';

export interface PlayerRatingAttributes {
    userId: string;
    guildId: string;
    mu: number;
    sigma: number;
    wins: number;
    losses: number;
}

export interface PlayerRatingInstance
    extends Model<PlayerRatingAttributes>,
        PlayerRatingAttributes {}

export type PlayerRatingModelStatic = ModelStatic<PlayerRatingInstance>;

export function definePlayerRatingModel(sequelize: Sequelize): PlayerRatingModelStatic {
    const attributes: ModelAttributes<PlayerRatingInstance, PlayerRatingAttributes> = {
        userId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        guildId: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
        },
        mu: {
            type: DataTypes.DOUBLE,
            allowNull: false,
        },
        sigma: {
            type: DataTypes.DOUBLE,
            allowNull: false,
        },
        wins: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        losses: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    };

    return sequelize.define<PlayerRatingInstance>('PlayerRating', attributes, {
        tableName: 'player_ratings',
        // Sequelize automatically handles the composite primary key
        // by having `primaryKey: true` on both `userId` and `guildId`.
    });
}