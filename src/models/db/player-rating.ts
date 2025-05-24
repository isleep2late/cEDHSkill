import { DataTypes, Model, Sequelize, ModelAttributes, ModelStatic } from 'sequelize';

export interface PlayerRatingAttributes {
    userId: string;
    mu: number;
    sigma: number;
}

export interface PlayerRatingInstance
    extends Model<PlayerRatingAttributes>,
        PlayerRatingAttributes {}

export type PlayerRatingModelStatic = ModelStatic<PlayerRatingInstance>;

export function definePlayerRatingModel(sequelize: Sequelize): PlayerRatingModelStatic {
    const attributes: ModelAttributes<PlayerRatingInstance, PlayerRatingAttributes> = {
        userId: {
            type: DataTypes.STRING,
            unique: true,
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
    };

    return sequelize.define<PlayerRatingInstance>('PlayerRating', attributes, {
        tableName: 'player_ratings',
    });
}