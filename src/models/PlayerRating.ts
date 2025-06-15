import { DataTypes, Model, Sequelize } from 'sequelize';

export class PlayerRating extends Model {
    declare userId: string;
    declare mu: number;
    declare sigma: number;
    declare wins: number;
    declare losses: number;
    declare draws: number;
    declare lastGame: Date;
}

export function initPlayerRatingModel(sequelize: Sequelize) {
    PlayerRating.init(
        {
            userId: {
                type: DataTypes.STRING,
                primaryKey: true,
            },
            mu: {
                type: DataTypes.FLOAT,
                allowNull: false,
                defaultValue: 25.0,
            },
            sigma: {
                type: DataTypes.FLOAT,
                allowNull: false,
                defaultValue: 8.333,
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
            draws: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            lastGame: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
        },
        {
            sequelize,
            modelName: 'PlayerRating',
            tableName: 'player_ratings',
            timestamps: false,
        }
    );
}
