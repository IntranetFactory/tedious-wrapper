const tedious = require('tedious');
const ConnectionPool = require('tedious-connection-pool');

const ConnectionString = require('./lib/connectionstring');
let logger = {};

class TediousWrapper
{
    constructor(config, _logger)
    {
        if (typeof config === 'string') {            
            var connectionString = config;
            config = {
                connection: {},
                pool:
                {
                    min: 1,
                    max: 10,
                    idleTimeout: 10000,
                    acquireTimeout: 12000
                }
            }
            config.connection = ConnectionString.resolve(connectionString);
        }     



        config.connection.options.useColumnNames = true;
        config.connection.options.rowCollectionOnDone = false;
        config.connection.options.rowCollectionOnRequestCompletion = false;
        this.config = config;

      

        if(_logger && typeof _logger.log === 'function')
        {
            logger = _logger;
        }

        else if(typeof _logger === 'function')
        {
            logger.log = _logger;
        }

        else if(_logger === true)
        {
            logger.log = (...args) => console.log(...args);
        }

        else
        {
            logger.log = () => {};
        }

        config.pool.log = logger;
        this.connectionPool = new ConnectionPool(config.pool, config.connection);
    }

    get types()
    {
        return tedious.TYPES;
    }

    connect(callback)
    {
        return new Promise(async (resolve, reject) =>
        {
            callback = typeof callback === 'function' ? callback : () => {};
            let connection;
            
            try
            {
                connection = await this.connectionPool.acquire();
            }

            catch(error)
            {
                logger.log('error', error.message);
                callback(error);
                return reject(error);
            }

            callback(null, connection);
            return resolve(connection);
        });
    }

    bulkLoad({table, columns, rows, callback})
    {
        return new Promise(async (resolve, reject) =>
        {
            callback = typeof callback === 'function' ? callback : () => {};
            let connection;
            
            try
            {
                connection = await this.connect();
            }

            catch(error)
            {
                callback(error);
                return reject(error);
            }

            logger.log('debug', `Inserting ${rows.length} rows into ${table}`);
            const bulkLoad = connection.newBulkLoad(table, (error, rowCount) =>
            {
                connection.release();

                if(error)
                {
                    logger.log('error', error.message);
                    callback(error);
                    return reject(error);
                }

                callback(null, rowCount);
                return resolve(rowCount);
            });

            columns.forEach((column) => bulkLoad.addColumn(...column));
            rows.forEach((row) => bulkLoad.addRow(row));
            connection.execBulkLoad(bulkLoad);
        });
    }

    destroy()
    {
        this.connectionPool.drain();
    }

    request({sql, parameters, options, callback})
    {
        return new Promise(async (resolve, reject) =>
        {
            parameters = parameters || [];
            options = options || {};
            options.transformers = options.transformers || [];
            callback = typeof callback === 'function' ? callback : () => {};
            let connection;
            
            try
            {
                connection = await this.connect();
            }

            catch(error)
            {
                callback(error);
                return reject(error);
            }

            const resultSets = []
            let metaDataCount = 0;
            let transform;
            let resultSet;
            let result = { resultSets: []};

            const request = new tedious.Request(sql, (error, rowCount) =>
            {
                connection.release();

                if(error)
                {
                    logger.log('error', error.message);
                    callback(error);
                    return reject(error);
                }

                // convenience property for results with single set
                if(result.resultSets.length==1) {
                    result.recordset = result.resultSets[0].rows;
                    result.rowsAffected = result.resultSets[0].rowsAffected;
                }

                callback(null, result);
                return resolve(result);
            });


            request.on('columnMetadata', (columns) =>
            {
                transform = {};

                Object.keys(columns).forEach((column) =>
                {
                    for(const transformer of options.transformers)
                    {
                        if(!transformer.resultSets || transformer.resultSets.includes(metaDataCount))
                        {
                            if(transformer.column instanceof RegExp && transformer.column.test(column))
                            {
                                transform[column] = transformer.transform;
                            }

                            else if(Array.isArray(transformer.column) && transformer.column.includes(column))
                            {
                                transform[column] = transformer.transform;
                            }

                            else if(typeof transformer.column === 'string' && transformer.column === column)
                            {
                                transform[column] = transformer.transform;
                            }
                        }
                    }
                });

                metaDataCount++;
                resultSet = { 
                    columns: columns,
                    rows: []
                };
            });
        
            request.on('row', (row) =>
            {
                const processedRow = {};
                
                Object.keys(row).forEach((column) =>
                {
                    processedRow[column] = transform[column] ? transform[column](row[column].value, row[column].metadata) : row[column].value;
                });

                resultSet.rows.push(processedRow);
            });
        
            request.on('done', (rowCount, more, rows) => {
                resultSet.rowsAffected = rowCount;
                result.resultSets.push(resultSet);
            });
        
            request.on('doneInProc', (rowCount, more, rows) =>
            {
                if(result.resultSets.length === metaDataCount-1)
                {
                    resultSet.rowsAffected = rowCount;
                    result.resultSets.push(resultSet);
                }
            });

            parameters.forEach((param) => request.addParameter(...param));

            if(options.callProcedure)
            {
                connection.callProcedure(request);
            }

            else
            {
                connection.execSql(request);
            }
        });
    }
}

module.exports = TediousWrapper;
