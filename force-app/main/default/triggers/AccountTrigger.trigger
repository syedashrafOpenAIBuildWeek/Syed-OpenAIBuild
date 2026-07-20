trigger AccountTrigger on Account (before insert) {
    for (Account acc : Trigger.new) {
        acc.Account_Trigger__c = 'Inserted';
        acc.TickerSymbol = 'Ticker';
    }
}
